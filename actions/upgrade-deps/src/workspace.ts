import type { CatalogUpdateResult, DependencyInfo, FileUpdate, PnpmUpdateCommand } from './types'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { env as processEnv } from 'node:process'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { isMap, isScalar, parseDocument } from 'yaml'
import { updatePackageManifestVersions, updateVersionSpecifier } from './dependencies'

function formatYamlScalar(source: string, value: string): string {
  if (source.startsWith('\''))
    return `'${value}'`
  if (source.startsWith('"'))
    return JSON.stringify(value)
  return value
}
function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

export function updatePnpmCatalogs(content: string, deps: DependencyInfo[]): CatalogUpdateResult {
  const document = parseDocument(content)
  if (document.errors.length)
    throw new Error(`Failed to parse pnpm-workspace.yaml: ${document.errors[0].message}`)
  const versions = new Map(deps.map(dep => [dep.name, dep.version]))
  const found = new Set<string>()
  const edits: Array<{ start: number, end: number, value: string }> = []
  const updateCatalog = (catalog: unknown, location: string): void => {
    if (catalog == null)
      return
    if (!isMap(catalog))
      throw new Error(`Invalid pnpm catalog at ${location}: expected a mapping`)
    for (const pair of catalog.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string')
        continue
      const version = versions.get(pair.key.value)
      if (!version)
        continue
      if (!isScalar(pair.value) || typeof pair.value.value !== 'string' || !pair.value.range)
        throw new Error(`Unsupported catalog value for ${location}.${pair.key.value}: expected a version string`)
      const [start, end] = pair.value.range
      edits.push({ start, end, value: formatYamlScalar(content.slice(start, end), updateVersionSpecifier(pair.value.value, version, `${location}.${pair.key.value}`)) })
      found.add(pair.key.value)
    }
  }
  updateCatalog(document.get('catalog', true), 'catalog')
  const catalogs = document.get('catalogs', true)
  if (catalogs != null) {
    if (!isMap(catalogs))
      throw new Error('Invalid pnpm catalogs: expected a mapping')
    for (const pair of catalogs.items) {
      if (isScalar(pair.key) && typeof pair.key.value === 'string')
        updateCatalog(pair.value, `catalogs.${pair.key.value}`)
    }
  }
  const updatedContent = edits.sort((a, b) => b.start - a.start).reduce((result, edit) => `${result.slice(0, edit.start)}${edit.value}${result.slice(edit.end)}`, content)
  return { catalogDependencies: [...found], content: updatedContent }
}

export async function findPnpmWorkspaceFile(startDir: string, cloneRoot: string): Promise<string | undefined> {
  const root = await realpath(path.resolve(cloneRoot))
  let current = await realpath(path.resolve(startDir))
  if (!isPathWithin(root, current))
    throw new Error(`Target directory ${startDir} is outside clone root ${cloneRoot}`)
  while (true) {
    const workspaceFile = path.join(current, 'pnpm-workspace.yaml')
    try {
      await readFile(workspaceFile, 'utf8')
      const resolved = await realpath(workspaceFile)
      if (!isPathWithin(root, resolved))
        throw new Error(`pnpm workspace file is outside clone root: ${workspaceFile}`)
      return workspaceFile
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error
    }
    if (current === root)
      return undefined
    current = path.dirname(current)
  }
}

export async function listPnpmWorkspacePackagePaths(workspaceDir: string): Promise<string[]> {
  const { stdout } = await exec.getExecOutput('pnpm', ['-r', 'list', '--depth', '-1', '--json'], { cwd: workspaceDir, silent: true })
  let packages: Array<{ path?: string }>
  try {
    packages = JSON.parse(stdout) as Array<{ path?: string }>
    if (!Array.isArray(packages))
      throw new TypeError('expected an array')
  }
  catch (error) { throw new Error(`Failed to read pnpm workspace packages: ${error instanceof Error ? error.message : String(error)}`) }
  const root = await realpath(path.resolve(workspaceDir))
  const paths = new Set([root])
  for (const pkg of packages) {
    if (!pkg.path)
      continue
    const packagePath = await realpath(path.resolve(root, pkg.path))
    if (!isPathWithin(root, packagePath))
      throw new Error(`pnpm returned a package path outside the workspace: ${pkg.path}`)
    paths.add(packagePath)
  }
  return [...paths]
}

export function getPnpmUpdateCommands(deps: DependencyInfo[], catalogDependencies: string[], targetPath: string, workspaceDir: string): PnpmUpdateCommand[] {
  const catalogNames = new Set(catalogDependencies)
  const regular = deps.filter(dep => !catalogNames.has(dep.name))
  return [
    ...(regular.length ? [{ args: ['-r', 'up', '--latest', ...regular.map(dep => dep.name)], cwd: targetPath }] : []),
    ...(catalogDependencies.length ? [{ args: ['install'], cwd: workspaceDir }] : []),
  ]
}

export function getSnapshotUpdateCommand(packageManager: 'npm' | 'yarn' | 'pnpm', deps: DependencyInfo[], targetRepo: string, repoPath: string): PnpmUpdateCommand | undefined {
  if (!deps.some(dep => /^tdesign-icons(?:-|$)/.test(dep.name)))
    return undefined
  const scripts: Record<string, string> = { 'tdesign-mobile-react': 'test:update', 'tdesign-mobile-vue': 'test:update', 'tdesign-react': 'test:update', 'tdesign-vue': 'test:update', 'tdesign-vue-next': 'test:vue:update' }
  const script = scripts[targetRepo]
  return script ? { args: packageManager === 'npm' ? ['run', script] : [script], cwd: repoPath } : undefined
}

export async function updatePackageDependencies(packageManager: 'npm' | 'yarn' | 'pnpm', deps: DependencyInfo[], repo: string, targetDir: string): Promise<void> {
  const targetPath = `./${repo}${targetDir ? `/${targetDir}` : ''}`
  core.startGroup('Install dependencies')
  try {
    if (packageManager !== 'pnpm') {
      const commands = { yarn: ['upgrade', '--latest'], npm: ['install'] } as const
      await exec.exec(packageManager, [...commands[packageManager], ...deps.map(dep => dep.name)], { cwd: targetPath })
    }
    else {
      const workspaceFile = await findPnpmWorkspaceFile(targetPath, `./${repo}`)
      if (!workspaceFile) {
        await exec.exec('pnpm', ['-r', 'up', '--latest', ...deps.map(dep => dep.name)], { cwd: targetPath })
      }
      else {
        const original = await readFile(workspaceFile, 'utf8')
        const catalog = updatePnpmCatalogs(original, deps)
        const catalogNames = new Set(catalog.catalogDependencies)
        const catalogDeps = deps.filter(dep => catalogNames.has(dep.name))
        const packagePaths = await listPnpmWorkspacePackagePaths(path.dirname(workspaceFile))
        const updates: FileUpdate[] = []
        for (const packagePath of packagePaths) {
          const manifest = path.join(packagePath, 'package.json')
          try {
            const result = updatePackageManifestVersions(await readFile(manifest, 'utf8'), catalogDeps, manifest)
            if (result.updated)
              updates.push({ filePath: manifest, content: result.content })
          }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
              throw error
          }
        }
        if (catalog.content !== original)
          updates.unshift({ filePath: workspaceFile, content: catalog.content })
        await Promise.all(updates.map(update => writeFile(update.filePath, update.content, 'utf8')))
        for (const command of getPnpmUpdateCommands(deps, catalog.catalogDependencies, targetPath, path.dirname(workspaceFile)))
          await exec.exec('pnpm', command.args, { cwd: command.cwd, ...(command.args[0] === 'install' ? { env: { ...processEnv as Record<string, string>, CI: 'false' } } : {}) })
      }
    }
  }
  finally {
    core.endGroup()
  }
  const snapshot = getSnapshotUpdateCommand(packageManager, deps, repo, `./${repo}`)
  if (snapshot) {
    core.startGroup('Update snapshots')
    try {
      await exec.exec(packageManager, snapshot.args, { cwd: snapshot.cwd })
    }
    finally {
      core.endGroup()
    }
  }
}
