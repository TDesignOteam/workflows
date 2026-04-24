import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import { updateWorkspaceManifest } from '@pnpm/workspace.manifest-writer'
import { readWorkspaceManifest } from '@pnpm/workspace.read-manifest'
import { GitHelper, GithubHelper } from '@workflows/utils'

const BRANCH_PATTERNS = {
  DEPS: (deps: Array<{ name: string, version: string }>) => {
    const depsSlug = deps.map(d => `${d.name}-${d.version}`).join('-')
    return `chore(deps): upgrade-${depsSlug}`
  },
}

const PR_TITLES = {
  DEPS: (deps: Array<{ name: string, version: string }>) => {
    const depList = deps.map(d => `${d.name} to ${d.version}`).join(', ')
    return `chore: upgrade ${depList}`
  },
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
    updatedCatalogs[''] = {}
    for (const dep of deps) {
      if (dep.name in manifest.catalog) {
        const current = manifest.catalog[dep.name] as string
        const prefix = current[0]
        if (prefix === '^' || prefix === '~') {
          updatedCatalogs[''][dep.name] = `${prefix}${dep.version}`
        }
        else {
          updatedCatalogs[''][dep.name] = dep.version
        }
      }
    }
  }

  if (manifest.catalogs) {
    for (const [catalogName, catalog] of Object.entries(manifest.catalogs)) {
      updatedCatalogs[catalogName] = {}
      for (const dep of deps) {
        if (dep.name in (catalog as Record<string, string>)) {
          const current = (catalog as Record<string, string>)[dep.name]
          const prefix = current[0]
          if (prefix === '^' || prefix === '~') {
            updatedCatalogs[catalogName][dep.name] = `${prefix}${dep.version}`
          }
          else {
            updatedCatalogs[catalogName][dep.name] = dep.version
          }
        }
      }
    }
  }

  const hasUpdates = Object.values(updatedCatalogs).some(catalog => Object.keys(catalog).length > 0)
  if (!hasUpdates) {
    core.info(`No matching dependencies found in catalog, skipping update`)
    return
  }

  await updateWorkspaceManifest(workspaceFile, {
    updatedCatalogs,
  })
  core.info(`Updated pnpm catalog in pnpm-workspace.yaml`)
}

async function getPkgLatestVersion(pkgNames: string[]): Promise<DependencyInfo[]> {
  const results: DependencyInfo[] = []
  for (const pkg of pkgNames) {
    const { stdout } = await exec.getExecOutput('npm', ['view', pkg, 'version'])
    results.push({
      name: pkg,
      version: stdout.trim(),
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

async function updateDependencies(context: TriggerContext): Promise<void> {
  const packageManager = core.getInput('package-manager') || 'npm'
  const deps = core.getMultilineInput('deps', { required: true })

  if (!deps || deps.length === 0) {
    throw new ActionError(ERROR_MESSAGES.MISSING_DEPS, { trigger: context.trigger })
  }

  const depInfos = await getPkgLatestVersion(deps)

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
  const branchName = BRANCH_PATTERNS.DEPS(depInfos)
  await gitHelper.createBranch(branchName)

  if (packageManager === 'pnpm') {
    await updatePnpmCatalog(depInfos, context.repo)
  }

  await updatePackageDependencies(packageManager, deps, context.repo)

  if (!await gitHelper.isNeedCommit()) {
    core.info('No changes to commit')
    return
  }

  const title = PR_TITLES.DEPS(depInfos)
  await gitHelper.commit(title)
  await gitHelper.push(branchName)

  await createDepsPr(title, branchName, baseBranch, context)
}

async function main(): Promise<void> {
  const repo = core.getInput('repo') || github.context.repo.repo
  const owner = core.getInput('owner') || github.context.repo.owner
  const token = core.getInput('token', { required: true }) || ''
  const dryRun = core.getBooleanInput('dry-run') || false
  const packageManager = core.getInput('package-manager') || 'npm'
  const deps = core.getMultilineInput('deps', { required: true })

  core.startGroup('upgrade-deps')
  core.info(`repo: ${repo}`)
  core.info(`owner: ${owner}`)
  core.info(`packageManager: ${packageManager}`)
  core.info(`deps: ${JSON.stringify(deps)}`)
  core.endGroup()

  await updateDependencies({
    repo,
    owner,
    token,
    dryRun,
    trigger: github.context.eventName,
  })
}

main()
