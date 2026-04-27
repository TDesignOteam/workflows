import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import { updateWorkspaceManifest } from '@pnpm/workspace.manifest-writer'
import { readWorkspaceManifest } from '@pnpm/workspace.read-manifest'
import { GitHelper, GithubHelper } from '@workflows/utils'

function getBranchName(deps: Array<{ name: string, version: string }>): string {
  const depsSlug = deps.map(d => `${d.name}-${d.version}`).join('-')
  return `chore(deps): upgrade-${depsSlug}`
}

function getPrTitle(deps: Array<{ name: string, version: string }>): string {
  const depList = deps.map(d => `${d.name} to ${d.version}`).join(', ')
  return `chore: upgrade ${depList}`
}

const ERROR_MESSAGES = {
  MISSING_DEPS: 'Missing deps input',
}

class ActionError extends Error {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message)
    this.name = 'ActionError'
    if (context) {
      core.error(`${message} ${JSON.stringify(context)}`)
    }
  }
}

interface TriggerContext {
  repo: string
  owner: string
  token: string
  dryRun: boolean
  trigger: string
}

interface DependencyInfo {
  name: string
  version: string
}

function getUpdatedVersion(currentVersion: string, newVersion: string): string {
  const prefix = currentVersion[0]
  if (prefix && (prefix === '^' || prefix === '~')) {
    return `${prefix}${newVersion}`
  }
  return newVersion
}

async function updatePnpmCatalog(deps: DependencyInfo[], repoPath: string): Promise<void> {
  const workspaceFile = path.join(repoPath, 'pnpm-workspace.yaml')

  let manifestContent: string
  try {
    manifestContent = await fs.readFile(workspaceFile, 'utf-8')
  }
  catch {
    core.info(`pnpm-workspace.yaml not found in ${repoPath}, skipping catalog update`)
    return
  }

  const manifest = await readWorkspaceManifest(manifestContent)
  if (!manifest) {
    core.info(`Failed to read pnpm-workspace.yaml, skipping catalog update`)
    return
  }

  const updatedCatalogs: Record<string, Record<string, string>> = {}

  if (manifest.catalog) {
    const defaultCatalogUpdates: Record<string, string> = {}
    for (const dep of deps) {
      if (dep.name in manifest.catalog) {
        defaultCatalogUpdates[dep.name] = getUpdatedVersion(manifest.catalog[dep.name] as string, dep.version)
      }
    }
    if (Object.keys(defaultCatalogUpdates).length > 0) {
      updatedCatalogs[''] = defaultCatalogUpdates
    }
  }

  if (manifest.catalogs) {
    for (const [catalogName, catalog] of Object.entries(manifest.catalogs)) {
      const catalogUpdates: Record<string, string> = {}
      const typedCatalog = catalog as Record<string, string>
      for (const dep of deps) {
        if (dep.name in typedCatalog) {
          catalogUpdates[dep.name] = getUpdatedVersion(typedCatalog[dep.name], dep.version)
        }
      }
      if (Object.keys(catalogUpdates).length > 0) {
        updatedCatalogs[catalogName] = catalogUpdates
      }
    }
  }

  const hasUpdates = Object.keys(updatedCatalogs).length > 0
  if (!hasUpdates) {
    core.info(`No matching dependencies found in catalog, skipping update`)
    return
  }

  await updateWorkspaceManifest(workspaceFile, { updatedCatalogs })
  core.info(`Updated pnpm catalog in pnpm-workspace.yaml`)
}

async function getPkgLatestVersion(pkgNames: string[]): Promise<DependencyInfo[]> {
  const results: DependencyInfo[] = []
  for (const pkg of pkgNames) {
    const response = await fetch(`https://registry.npmjs.org/${pkg}/latest`)
    if (!response.ok) {
      core.error(`Failed to get ${pkg} info from npm registry, status code: ${response.status}`)
      continue
    }
    const info = await response.json() as { 'version'?: string }
    const latest = info['version']
    if (!latest) {
      core.error(`No version found for ${pkg}`)
      continue
    }
    core.info(`Latest version of ${pkg} is ${latest}`)
    results.push({
      name: pkg,
      version: latest,
    })
  }
  return results
}

async function corepackEnable(): Promise<void> {
  await exec.exec('corepack', ['enable'])
}

async function updatePackageDependencies(packageManager: string, deps: string[], repo: string): Promise<void> {
  const repoPath = `./${repo}`
  if (packageManager === 'pnpm') {
    await exec.exec('pnpm', ['up', ...deps, '--latest'], { cwd: repoPath })
  }
  else if (packageManager === 'yarn') {
    await exec.exec('yarn', ['upgrade', ...deps, '--latest'], { cwd: repoPath })
  }
  else {
    await exec.exec('npm', ['update', ...deps], { cwd: repoPath })
  }
}

async function createDepsPr(
  title: string,
  branchName: string,
  baseBranch: string,
  context: TriggerContext,
): Promise<void> {
  const githubHelper = new GithubHelper({
    owner: context.owner,
    repo: context.repo,
    token: context.token,
    dryRun: context.dryRun,
  })
  await githubHelper.createPR(title, branchName, title, baseBranch)
}

export async function updateDependencies(context: TriggerContext): Promise<void> {
  const packageManager = core.getInput('package-manager') || 'npm'
  const deps = core.getMultilineInput('deps', { required: true,trimWhitespace:true })
  core.info(`deps: ${JSON.stringify(deps)}`)

  if (!deps.length) {
    throw new ActionError(ERROR_MESSAGES.MISSING_DEPS, { trigger: context.trigger })
  }

  const depInfos = await getPkgLatestVersion(deps)
  core.info(`depInfos: ${JSON.stringify(depInfos)}`)

  if (packageManager !== 'npm') {
    await corepackEnable()
  }

  const gitHelper = new GitHelper({
    repo: context.repo,
    owner: context.owner,
    token: context.token,
    dryRun: context.dryRun,
  })

  const baseBranch = await gitHelper.clone()
  const branchName = getBranchName(depInfos)
  await gitHelper.createBranch(branchName)

  if (packageManager === 'pnpm') {
    await updatePnpmCatalog(depInfos, context.repo)
  }

  await updatePackageDependencies(packageManager, deps, context.repo)

  if (!(await gitHelper.isNeedCommit())) {
    core.info('No changes to commit')
    return
  }

  const title = getPrTitle(depInfos)
  await gitHelper.commit(title)
  await gitHelper.push(branchName)

  await createDepsPr(title, branchName, baseBranch, context)
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
    trigger: github.context.eventName,
  })
}
