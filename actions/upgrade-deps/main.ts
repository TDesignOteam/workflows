import type { ParseError } from 'jsonc-parser'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import { GitHelper, GithubHelper } from '@workflows/utils'
import { applyEdits, modify, parse as parseJson } from 'jsonc-parser'
import { isMap, isScalar, parseDocument } from 'yaml'

interface TriggerContext {
  repo: string
  owner: string
  token: string
  dryRun: boolean
}

export interface DependencyInfo {
  name: string
  repositoryDirectory?: string
  version: string
  repositoryUrl?: string
  release?: DependencyRelease
}

export interface DependencyRelease {
  body: string
  tag: string
  url: string
}

export interface GithubRepository {
  owner: string
  repo: string
}

export interface CatalogUpdateResult {
  catalogDependencies: string[]
  content: string
}

export interface PackageManifestUpdateResult {
  content: string
  updated: boolean
}

export interface PnpmUpdateCommand {
  args: string[]
  cwd: string
}

interface FileUpdate {
  content: string
  filePath: string
}

const PACKAGE_MANAGER_COMMANDS = {
  pnpm: { cmd: 'pnpm', args: ['up', '-r', '--latest'] },
  yarn: { cmd: 'yarn', args: ['upgrade', '--latest'] },
  npm: { cmd: 'npm', args: ['install'] },
} as const

const PR_TEMPLATE_PATHS = [
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md',
  'pull_request_template.md',
  'docs/PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
]

const COMPONENT_REPOSITORIES = new Set([
  'tdesign-flutter',
  'tdesign-miniprogram',
  'tdesign-mobile-react',
  'tdesign-mobile-vue',
  'tdesign-react',
  'tdesign-vue',
  'tdesign-vue-next',
])

const NO_CHANGELOG_DEPENDENCIES = new Set([
  '@tdesign/site-components',
  '@tdesign/theme-generator',
])

const NO_CHANGELOG_CHECKBOX = '- [x] 本条 PR 不需要纳入 Changelog'

const CHANGELOG_TARGET_SECTIONS: Record<string, string[]> = {
  'tdesign-miniprogram': ['tdesign-miniprogram', '@tdesign/uniapp'],
  'tdesign-react': ['tdesign-react'],
  'tdesign-vue-next': ['tdesign-vue-next'],
}

type PackageManager = keyof typeof PACKAGE_MANAGER_COMMANDS

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const

type DependencyField = typeof DEPENDENCY_FIELDS[number]

const SEMVER_PATTERN = /^([~^]?)((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-z-][0-9a-z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-z-][0-9a-z-]*))*)?(?:\+[0-9a-z-]+(?:\.[0-9a-z-]+)*)?)$/i

function slugify(value: string): string {
  return value.replace(/@/g, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
}

export function getBranchName(deps: DependencyInfo[]): string {
  const depsSlug = deps.map(d => `${slugify(d.name)}-${slugify(d.version)}`).join('-')
  return `chore/deps/upgrade-${depsSlug}`
}

export function getPrTitle(deps: DependencyInfo[]): string {
  const depList = deps.map(d => `${d.name} to ${d.version}`).join(', ')
  return `chore: upgrade ${depList}`
}

export function getRepoPath(repo: string, targetDir: string): string {
  const base = `./${repo}`
  return targetDir ? path.join(base, targetDir) : base
}

export function parseDependencyName(spec: string): string {
  const value = spec.trim()
  if (!value)
    throw new Error('Empty dependency name')

  const versionSeparator = value.startsWith('@')
    ? value.indexOf('@', value.indexOf('/') + 1)
    : value.lastIndexOf('@')

  if (versionSeparator > 0)
    throw new Error(`Dependency versions are not supported: ${spec}. Please pass package names only.`)

  return value
}

export function parseDependencyInputs(inputs: string[]): string[] {
  const deps = inputs
    .flatMap(input => input.split(/\s+/))
    .map(item => item.trim())
    .filter(Boolean)
    .map(parseDependencyName)

  if (!deps.length)
    throw new Error('Missing deps input')

  return deps
}

export function validatePackageManager(packageManager: string): PackageManager {
  if (packageManager in PACKAGE_MANAGER_COMMANDS)
    return packageManager as PackageManager

  throw new Error(`Unsupported package-manager "${packageManager}". Supported values: npm, yarn, pnpm.`)
}

export function updateVersionSpecifier(specifier: string, version: string, location: string): string {
  const match = specifier.match(SEMVER_PATTERN)
  if (!match) {
    throw new Error(`Unsupported version specifier "${specifier}" for ${location}. Supported formats: ^1.2.3, ~1.2.3, or 1.2.3.`)
  }
  const targetVersion = version.match(SEMVER_PATTERN)
  if (!targetVersion || targetVersion[1])
    throw new Error(`Invalid target version "${version}" for ${location}`)
  return `${match[1]}${targetVersion[2]}`
}

function formatYamlScalar(source: string, value: string): string {
  if (source.startsWith('\''))
    return `'${value}'`
  if (source.startsWith('"'))
    return JSON.stringify(value)
  return value
}

export function updatePnpmCatalogs(content: string, deps: DependencyInfo[]): CatalogUpdateResult {
  const document = parseDocument(content)
  if (document.errors.length) {
    throw new Error(`Failed to parse pnpm-workspace.yaml: ${document.errors[0].message}`)
  }

  const depVersions = new Map(deps.map(dep => [dep.name, dep.version]))
  const catalogDependencies = new Set<string>()
  const edits: Array<{ end: number, start: number, value: string }> = []

  const updateCatalog = (catalog: unknown, location: string): void => {
    if (catalog == null)
      return
    if (!isMap(catalog))
      throw new Error(`Invalid pnpm catalog at ${location}: expected a mapping`)

    for (const pair of catalog.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string')
        continue

      const name = pair.key.value
      const version = depVersions.get(name)
      if (!version)
        continue
      if (!isScalar(pair.value) || typeof pair.value.value !== 'string' || !pair.value.range) {
        throw new Error(`Unsupported catalog value for ${location}.${name}: expected a version string`)
      }

      const specifier = pair.value.value
      const nextSpecifier = updateVersionSpecifier(specifier, version, `${location}.${name}`)
      const [start, end] = pair.value.range
      edits.push({
        end,
        start,
        value: formatYamlScalar(content.slice(start, end), nextSpecifier),
      })
      catalogDependencies.add(name)
    }
  }

  updateCatalog(document.get('catalog', true), 'catalog')
  const namedCatalogs = document.get('catalogs', true)
  if (namedCatalogs != null) {
    if (!isMap(namedCatalogs))
      throw new Error('Invalid pnpm catalogs: expected a mapping')
    for (const pair of namedCatalogs.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string')
        continue
      updateCatalog(pair.value, `catalogs.${pair.key.value}`)
    }
  }

  const updatedContent = edits
    .sort((a, b) => b.start - a.start)
    .reduce((result, edit) => `${result.slice(0, edit.start)}${edit.value}${result.slice(edit.end)}`, content)

  return {
    catalogDependencies: [...catalogDependencies],
    content: updatedContent,
  }
}

export function updatePackageManifestVersions(
  content: string,
  deps: DependencyInfo[],
  manifestPath = 'package.json',
  dependencyFields: readonly DependencyField[] = DEPENDENCY_FIELDS,
): PackageManifestUpdateResult {
  const errors: ParseError[] = []
  const manifest = parseJson(content, errors, { allowTrailingComma: true }) as Record<string, unknown> | undefined
  if (errors.length || !manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`Failed to parse ${manifestPath}`)
  }

  let updatedContent = content
  let updated = false
  for (const field of dependencyFields) {
    const dependencies = manifest[field]
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies))
      continue

    for (const dep of deps) {
      const specifier = (dependencies as Record<string, unknown>)[dep.name]
      if (specifier === undefined)
        continue
      if (typeof specifier !== 'string')
        throw new Error(`Unsupported version specifier for ${manifestPath}#${field}.${dep.name}: expected a string`)
      if (specifier.startsWith('catalog:'))
        continue

      const nextSpecifier = updateVersionSpecifier(specifier, dep.version, `${manifestPath}#${field}.${dep.name}`)
      if (nextSpecifier === specifier)
        continue
      updatedContent = applyEdits(updatedContent, modify(updatedContent, [field, dep.name], nextSpecifier, {}))
      updated = true
    }
  }

  return { content: updatedContent, updated }
}

export async function updatePeerDependencyVersions(
  packagePaths: string[],
  deps: DependencyInfo[],
  cloneRoot: string,
): Promise<void> {
  let root: string
  try {
    root = await realpath(path.resolve(cloneRoot))
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return
    throw error
  }

  const updates = await Promise.all(packagePaths.map(async (packagePath): Promise<FileUpdate | undefined> => {
    const manifestPath = path.join(packagePath, 'package.json')
    let resolvedManifestPath: string
    try {
      resolvedManifestPath = await realpath(manifestPath)
      if (!isPathWithin(root, resolvedManifestPath))
        throw new Error(`Package manifest is outside the clone: ${manifestPath}`)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return undefined
      throw error
    }

    const content = await readFile(resolvedManifestPath, 'utf8')
    const result = updatePackageManifestVersions(content, deps, resolvedManifestPath, ['peerDependencies'])
    return result.updated ? { content: result.content, filePath: resolvedManifestPath } : undefined
  }))

  await Promise.all(updates
    .filter((update): update is FileUpdate => update !== undefined)
    .map(update => writeFile(update.filePath, update.content, 'utf8')))
}

export function parseGithubRepository(repositoryUrl?: string): GithubRepository | undefined {
  if (!repositoryUrl)
    return undefined

  const normalizedUrl = repositoryUrl
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
    .replace(/^git:\/\/github\.com\//, 'https://github.com/')

  try {
    const url = new URL(normalizedUrl)
    if (url.hostname !== 'github.com')
      return undefined

    const [owner, repoName] = url.pathname.replace(/^\//, '').split('/')
    const repo = repoName?.replace(/\.git$/, '')
    return owner && repo ? { owner, repo } : undefined
  }
  catch {
    return undefined
  }
}

export async function fetchPackageVersion(pkg: string): Promise<DependencyInfo> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${pkg}/latest`)
    if (!response.ok) {
      throw new Error(`status code: ${response.status}`)
    }
    const { version, repository } = await response.json() as {
      repository?: string | { directory?: string, url?: string }
      version?: string
    }
    if (!version) {
      throw new Error('no version found')
    }
    core.info(`Latest version of ${pkg} is ${version}`)
    const repositoryUrl = typeof repository === 'string' ? repository : repository?.url
    const repositoryDirectory = typeof repository === 'object' ? repository?.directory : undefined
    return {
      name: pkg,
      version,
      ...(repositoryUrl ? { repositoryUrl } : {}),
      ...(repositoryDirectory ? { repositoryDirectory } : {}),
    }
  }
  catch (error) {
    throw new Error(`Failed to get ${pkg} info from npm registry: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function resolveDependencyInfos(deps: string[]): Promise<DependencyInfo[]> {
  return Promise.all(deps.map(fetchPackageVersion))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function extractVersionChangelog(content: string, version: string): string | undefined {
  const lines = content.split('\n')
  const versionPattern = new RegExp(`(?:^|[^0-9a-z])v?${escapeRegExp(version)}(?=$|[^0-9a-z])`, 'i')

  const startIndex = lines.findIndex((line) => {
    const heading = getMarkdownHeading(line)
    const headingText = heading?.replace(/\]\([^)]*\)/g, ']')
    return headingText !== undefined && versionPattern.test(headingText)
  })
  if (startIndex === -1)
    return undefined

  const headingLevel = lines[startIndex].match(/^#+/)?.[0].length
  if (!headingLevel)
    return undefined

  const endIndex = lines.findIndex((line, index) => (
    index > startIndex && (line.match(/^#{1,6}(?=[ \t])/)?.[0].length ?? 7) <= headingLevel
  ))
  return lines.slice(startIndex, endIndex === -1 ? undefined : endIndex).join('\n').trim()
}

export async function fetchDependencyRelease(dep: DependencyInfo, token: string): Promise<DependencyRelease | undefined> {
  const repository = parseGithubRepository(dep.repositoryUrl)
  if (!repository) {
    core.warning(`No GitHub repository found for ${dep.name}; skipping changelog`)
    return undefined
  }

  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.raw+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token && token !== 'test') {
    headers.Authorization = `Bearer ${token}`
  }

  try {
    const changelogPath = [...(dep.repositoryDirectory?.split('/').filter(Boolean) ?? []), 'CHANGELOG.md']
      .map(segment => encodeURIComponent(segment))
      .join('/')
    const response = await fetch(
      `https://api.github.com/repos/${repository.owner}/${repository.repo}/contents/${changelogPath}`,
      { headers },
    )
    if (response.status === 404) {
      core.warning(`No CHANGELOG.md found for ${dep.name}`)
      return undefined
    }
    if (!response.ok)
      throw new Error(`status code: ${response.status}`)

    const body = extractVersionChangelog(await response.text(), dep.version)
    if (!body) {
      core.warning(`No ${dep.version} entry found in CHANGELOG.md for ${dep.name}`)
      return undefined
    }

    const url = `https://github.com/${repository.owner}/${repository.repo}/blob/HEAD/${changelogPath}`
    core.info(`Changelog found for ${dep.name}@${dep.version}: ${url}`)
    return {
      body,
      tag: `${dep.name}@${dep.version}`,
      url,
    }
  }
  catch (error) {
    core.warning(`Failed to get CHANGELOG.md for ${dep.name}@${dep.version}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

export async function resolveDependencyReleases(deps: DependencyInfo[], token: string): Promise<DependencyInfo[]> {
  return Promise.all(deps.map(async dep => ({
    ...dep,
    release: await fetchDependencyRelease(dep, token),
  })))
}

function isPathWithin(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate)
  return relativePath === '' || (!path.isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`))
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
      const resolvedWorkspaceFile = await realpath(workspaceFile)
      if (!isPathWithin(root, resolvedWorkspaceFile))
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
  const { stdout } = await exec.getExecOutput(
    'pnpm',
    ['-r', 'list', '--depth', '-1', '--json'],
    { cwd: workspaceDir, silent: true },
  )

  let packages: Array<{ path?: string }>
  try {
    packages = JSON.parse(stdout) as Array<{ path?: string }>
    if (!Array.isArray(packages))
      throw new TypeError('expected an array')
  }
  catch (error) {
    throw new Error(`Failed to read pnpm workspace packages: ${error instanceof Error ? error.message : String(error)}`)
  }

  const root = await realpath(path.resolve(workspaceDir))
  const packagePaths = new Set([root])
  for (const pkg of packages) {
    if (!pkg.path)
      continue
    const packagePath = await realpath(path.resolve(root, pkg.path))
    if (!isPathWithin(root, packagePath))
      throw new Error(`pnpm returned a package path outside the workspace: ${pkg.path}`)
    packagePaths.add(packagePath)
  }
  return [...packagePaths]
}

export function getPnpmUpdateCommands(
  deps: DependencyInfo[],
  catalogDependencies: string[],
  targetPath: string,
  workspaceDir: string,
): PnpmUpdateCommand[] {
  const catalogNames = new Set(catalogDependencies)
  const nonCatalogDependencies = deps.filter(dep => !catalogNames.has(dep.name))
  const commands: PnpmUpdateCommand[] = []

  if (nonCatalogDependencies.length) {
    commands.push({
      args: ['-r', 'up', '--latest', ...nonCatalogDependencies.map(dep => dep.name)],
      cwd: targetPath,
    })
  }
  if (catalogDependencies.length)
    commands.push({ args: ['install', '--no-frozen-lockfile'], cwd: workspaceDir })

  return commands
}

async function preparePnpmCatalogUpdates(
  workspaceFile: string,
  deps: DependencyInfo[],
): Promise<{ catalogDependencies: string[], updates: FileUpdate[] }> {
  const workspaceContent = await readFile(workspaceFile, 'utf8')
  const catalogResult = updatePnpmCatalogs(workspaceContent, deps)
  if (!catalogResult.catalogDependencies.length)
    return { catalogDependencies: [], updates: [] }

  const catalogNames = new Set(catalogResult.catalogDependencies)
  const catalogDeps = deps.filter(dep => catalogNames.has(dep.name))
  const workspaceDir = path.dirname(workspaceFile)
  const packagePaths = await listPnpmWorkspacePackagePaths(workspaceDir)
  const manifestUpdates = await Promise.all(packagePaths.map(async (packagePath): Promise<FileUpdate | undefined> => {
    const manifestPath = path.join(packagePath, 'package.json')
    let content: string
    let resolvedManifestPath: string
    try {
      resolvedManifestPath = await realpath(manifestPath)
      if (!isPathWithin(workspaceDir, resolvedManifestPath))
        throw new Error(`Package manifest is outside the workspace: ${manifestPath}`)
      content = await readFile(resolvedManifestPath, 'utf8')
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return undefined
      throw error
    }

    const result = updatePackageManifestVersions(content, catalogDeps, resolvedManifestPath)
    return result.updated ? { content: result.content, filePath: resolvedManifestPath } : undefined
  }))

  const updates = manifestUpdates.filter((update): update is FileUpdate => update !== undefined)
  if (catalogResult.content !== workspaceContent) {
    updates.unshift({ content: catalogResult.content, filePath: workspaceFile })
  }
  return { catalogDependencies: catalogResult.catalogDependencies, updates }
}

async function updatePnpmDependencies(deps: DependencyInfo[], repo: string, targetDir: string): Promise<void> {
  const cloneRoot = getRepoPath(repo, '')
  const targetPath = getRepoPath(repo, targetDir)
  const workspaceFile = await findPnpmWorkspaceFile(targetPath, cloneRoot)
  if (!workspaceFile) {
    await exec.exec('pnpm', ['-r', 'up', '--latest', ...deps.map(dep => dep.name)], { cwd: targetPath })
    await updatePeerDependencyVersions([targetPath], deps, cloneRoot)
    return
  }

  const { catalogDependencies, updates } = await preparePnpmCatalogUpdates(workspaceFile, deps)
  await Promise.all(updates.map(update => writeFile(update.filePath, update.content, 'utf8')))

  const commands = getPnpmUpdateCommands(deps, catalogDependencies, targetPath, path.dirname(workspaceFile))
  for (const command of commands) {
    await exec.exec('pnpm', command.args, { cwd: command.cwd })
  }
  await updatePeerDependencyVersions(
    await listPnpmWorkspacePackagePaths(path.dirname(workspaceFile)),
    deps,
    cloneRoot,
  )
}

export async function updatePackageDependencies(packageManager: PackageManager, deps: DependencyInfo[], repo: string, targetDir: string): Promise<void> {
  if (packageManager === 'pnpm') {
    await updatePnpmDependencies(deps, repo, targetDir)
    return
  }

  const repoPath = getRepoPath(repo, targetDir)
  const { cmd, args } = PACKAGE_MANAGER_COMMANDS[packageManager]
  await exec.exec(cmd, [...args, ...deps.map(dep => dep.name)], { cwd: repoPath })
  await updatePeerDependencyVersions([repoPath], deps, getRepoPath(repo, ''))
}

export async function readPullRequestTemplate(repoPath: string): Promise<string | undefined> {
  for (const templatePath of PR_TEMPLATE_PATHS) {
    try {
      return await readFile(path.join(repoPath, templatePath), 'utf8')
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error
    }
  }
  return undefined
}

function getMarkdownHeading(line: string): string | undefined {
  const prefix = line.match(/^#{1,6}[ \t]+/)
  return prefix ? line.slice(prefix[0].length).trim() : undefined
}

function insertAfterHeading(body: string, heading: RegExp | string, content: string): { body: string, inserted: boolean } {
  const lines = body.split('\n')
  const headingIndex = lines.findIndex((line) => {
    const value = getMarkdownHeading(line)
    return value !== undefined && (typeof heading === 'string' ? value === heading : heading.test(value))
  })
  if (headingIndex === -1)
    return { body, inserted: false }

  lines.splice(headingIndex + 1, 0, '', content)
  return { body: lines.join('\n'), inserted: true }
}

function formatReleaseBody(body: string): string {
  return body
    .trim()
    .replace(/^(#{1,6})(?=\s)/gm, heading => '#'.repeat(Math.min(6, heading.length + 3)))
}

export function getDependencySummary(deps: DependencyInfo[]): string {
  return [
    '自动升级以下依赖：',
    '',
    ...deps.map(dep => `- \`${dep.name}\` 升级至 \`${dep.version}\``),
  ].join('\n')
}

export function getReleaseNotesMarkdown(deps: DependencyInfo[]): string {
  return deps.map((dep) => {
    const npmUrl = `https://www.npmjs.com/package/${dep.name}/v/${dep.version}`
    if (!dep.release) {
      return `#### [\`${dep.name}@${dep.version}\`](${npmUrl})\n\n未在仓库的 CHANGELOG.md 中找到对应版本日志。`
    }

    return `#### [\`${dep.name}@${dep.version}\`](${dep.release.url})\n\n${formatReleaseBody(dep.release.body)}`
  }).join('\n\n')
}

type ChangelogType = 'build' | 'chore' | 'ci' | 'docs' | 'feat' | 'feat!' | 'fix' | 'perf' | 'refactor' | 'style' | 'test'

interface ChangelogEntry {
  text: string
  type: ChangelogType
}

function getChangelogType(heading: string): ChangelogType | undefined {
  const value = heading.toLowerCase()
  if (/breaking changes?|破坏性/.test(value))
    return 'feat!'
  if (/bug fixes?|fixes|修复/.test(value))
    return 'fix'
  if (/features?|新特性|新增功能/.test(value))
    return 'feat'
  if (/performance|性能/.test(value))
    return 'perf'
  if (/documentation|\bdocs?\b|文档/.test(value))
    return 'docs'
  if (/refactor|重构/.test(value))
    return 'refactor'
  if (/tests?|测试/.test(value))
    return 'test'
  if (/\bci\b|持续集成/.test(value))
    return 'ci'
  if (/build|构建/.test(value))
    return 'build'
  if (/styles?|代码风格/.test(value))
    return 'style'
  if (/others?|其他/.test(value))
    return 'chore'
  return undefined
}

export function parseReleaseChangelog(body: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  const parents: Array<{ indent: number, text: string }> = []
  let currentType: ChangelogType | undefined

  for (const line of body.split('\n')) {
    const heading = getMarkdownHeading(line)
    if (heading !== undefined) {
      currentType = getChangelogType(heading)
      parents.length = 0
      continue
    }

    const bulletPrefix = line.match(/^([ \t]*)[-*+][ \t]+/)
    if (!bulletPrefix || !currentType)
      continue

    const indent = bulletPrefix[1].replace(/\t/g, '  ').length
    const text = line.slice(bulletPrefix[0].length).trim()
    if (!text)
      continue

    while (parents.length && parents[parents.length - 1].indent >= indent) {
      parents.pop()
    }

    if (text.endsWith(':')) {
      parents.push({ indent, text: text.slice(0, -1) })
      continue
    }

    const parentText = parents.map(parent => parent.text).join(': ')
    entries.push({
      text: parentText ? `${parentText}: ${text}` : text,
      type: currentType,
    })
  }

  return entries
}

function formatChangelogType(type: ChangelogType, scoped: boolean): string {
  const breaking = type.endsWith('!')
  const baseType = breaking ? type.slice(0, -1) : type
  return `${baseType}${scoped ? '(Icon)' : ''}${breaking ? '!' : ''}`
}

export function getChangelogMarkdown(deps: DependencyInfo[], targetRepo: string): string {
  const scoped = COMPONENT_REPOSITORIES.has(targetRepo)
  return deps.filter(dep => !NO_CHANGELOG_DEPENDENCIES.has(dep.name)).flatMap((dep) => {
    const entries = dep.release ? parseReleaseChangelog(dep.release.body) : []
    if (!entries.length) {
      return [`- ${formatChangelogType('chore', scoped)}: upgrade ${dep.name} to ${dep.version}`]
    }
    return entries.map(entry => `- ${formatChangelogType(entry.type, scoped)}: ${entry.text}`)
  }).join('\n')
}

function buildNoChangelogPullRequestBody(template: string | undefined): string {
  if (!template)
    return NO_CHANGELOG_CHECKBOX

  const body = template.trim()
  const updatedBody = body.replace(
    /^- \[ \] 本条 PR 不需要纳入 Changelog\r?$/m,
    NO_CHANGELOG_CHECKBOX,
  )
  return updatedBody === body ? `${body}\n\n${NO_CHANGELOG_CHECKBOX}` : updatedBody
}

function fillTDesignCheckboxes(template: string): string {
  const checkedLabels = [
    '其他',
    '文档已补充或无须补充',
    '代码演示已提供或无须提供',
    'TypeScript 定义已补充或无须补充',
    'Changelog 已提供或无须提供',
  ]

  return template
    .replace(/^- \[ \] (.+)$/gm, (line, label: string) => (
      checkedLabels.includes(label.trim()) ? line.replace('[ ]', '[x]') : line
    ))
    .replace(/^- fix\(组件名称\): 处理问题或特性描述 \.\.\.$/gm, '')
}

function insertChangelog(body: string, targetRepo: string, changelog: string): { body: string, inserted: boolean } {
  const targetSections = CHANGELOG_TARGET_SECTIONS[targetRepo] ?? []
  let result = body
  let inserted = false
  for (const section of targetSections) {
    const sectionResult = insertAfterHeading(result, section, changelog)
    result = sectionResult.body
    inserted ||= sectionResult.inserted
  }

  if (inserted)
    return { body: result, inserted }
  return insertAfterHeading(result, /更新日志|changelog|release notes/i, changelog)
}

export function buildPullRequestBody(template: string | undefined, deps: DependencyInfo[], targetRepo: string): string {
  if (deps.length && deps.every(dep => NO_CHANGELOG_DEPENDENCIES.has(dep.name))) {
    return buildNoChangelogPullRequestBody(template)
  }

  const summary = getDependencySummary(deps)
  const releaseNotes = getReleaseNotesMarkdown(deps)
  const background = `${summary}\n\n${releaseNotes}`
  const changelog = getChangelogMarkdown(deps, targetRepo)
  if (!template) {
    return `## 依赖升级\n\n${background}\n\n## 版本日志\n\n${changelog}`
  }

  let body = fillTDesignCheckboxes(template.trim())
  const issueResult = insertAfterHeading(body, /相关 Issue|related issues?/i, '无')
  body = issueResult.body
  const backgroundResult = insertAfterHeading(body, /需求背景|解决方案|background|summary|description/i, background)
  body = backgroundResult.body
  const changelogResult = insertChangelog(body, targetRepo, changelog)
  body = changelogResult.body

  const fallbackSections = [
    !backgroundResult.inserted ? `## 依赖升级\n\n${background}` : '',
    !changelogResult.inserted ? `## 版本日志\n\n${changelog}` : '',
  ].filter(Boolean)

  return fallbackSections.length ? `${fallbackSections.join('\n\n')}\n\n${body}` : body
}

export async function updateDependencies(context: TriggerContext): Promise<void> {
  const packageManager = validatePackageManager(core.getInput('package-manager') || 'npm')
  const targetDir = core.getInput('target-dir') || ''
  const customTitle = core.getInput('title') || ''
  const deps = parseDependencyInputs(core.getMultilineInput('deps', { required: true, trimWhitespace: true }))

  core.info(`deps: ${JSON.stringify(deps)}`)
  core.info(`target-dir: ${targetDir || 'default (repo root)'}`)
  if (customTitle) {
    core.info(`custom-title: ${customTitle}`)
  }

  let depInfos = await resolveDependencyInfos(deps)
  core.info(`depInfos: ${JSON.stringify(depInfos)}`)

  if (packageManager !== 'npm') {
    await exec.exec('corepack', ['enable'])
  }

  const gitHelper = new GitHelper({
    repo: context.repo,
    owner: context.owner,
    token: context.token,
    dryRun: context.dryRun,
  })

  const baseBranch = await gitHelper.clone()
  await gitHelper.initSubmodule()
  const pullRequestTemplate = await readPullRequestTemplate(getRepoPath(context.repo, ''))
  depInfos = await resolveDependencyReleases(depInfos, context.token)
  const branchName = getBranchName(depInfos)
  await gitHelper.createBranch(branchName)

  await updatePackageDependencies(packageManager, depInfos, context.repo, targetDir)

  if (!(await gitHelper.isNeedCommit())) {
    core.info('No changes to commit')
    return
  }

  core.startGroup('Changes to commit')
  await gitHelper.printDiff()
  core.endGroup()

  const title = customTitle || getPrTitle(depInfos)
  const body = buildPullRequestBody(pullRequestTemplate, depInfos, context.repo)
  await gitHelper.commit(title)
  await gitHelper.push(branchName)
  const githubHelper = new GithubHelper({
    owner: context.owner,
    repo: context.repo,
    token: context.token,
    dryRun: context.dryRun,
  })
  await githubHelper.createPR(title, branchName, body, baseBranch)
}

export async function main(): Promise<void> {
  const repo = core.getInput('repo') || github.context.repo.repo
  const owner = core.getInput('owner') || github.context.repo.owner
  const token = core.getInput('token', { required: true })
  const dryRun = core.getBooleanInput('dry-run')

  core.startGroup('upgrade-deps')
  core.info(`repo: ${repo}`)
  core.info(`owner: ${owner}`)
  core.endGroup()

  await updateDependencies({
    repo,
    owner,
    token,
    dryRun,
  })
}
