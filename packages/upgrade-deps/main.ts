import * as path from 'node:path'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import { GitHelper, GithubHelper } from '@workflows/utils'

function getBranchName(deps: Array<{ name: string, version: string }>): string {
  const depsSlug = deps.map(d => `${d.name.replace(/@/g, '').replace(/\//g, '-')}-${d.version}`).join('-')
  return `chore/deps/upgrade-${depsSlug}`
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

async function getPkgLatestVersion(pkgNames: string[]): Promise<DependencyInfo[]> {
  const results: DependencyInfo[] = []
  for (const pkg of pkgNames) {
    const response = await fetch(`https://registry.npmjs.org/${pkg}/latest`)
    if (!response.ok) {
      core.error(`Failed to get ${pkg} info from npm registry, status code: ${response.status}`)
      continue
    }
    const info = await response.json() as { version?: string }
    const latest = info.version
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

async function updatePackageDependencies(packageManager: string, deps: string[], repo: string, targetDir: string): Promise<void> {
  let repoPath = `./${repo}`
  if (targetDir) {
    repoPath = path.join(repoPath, targetDir)
  }
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
  const targetDir = core.getInput('target-dir') || ''
  const customTitle = core.getInput('title') || ''
  const deps = core.getMultilineInput('deps', { required: true, trimWhitespace: true })
  core.info(`deps: ${JSON.stringify(deps)}`)
  core.info(`target-dir: ${targetDir || 'default (repo root)'}`)
  if (customTitle) {
    core.info(`custom-title: ${customTitle}`)
  }

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
  await gitHelper.initSubmodule()
  const branchName = getBranchName(depInfos)
  await gitHelper.createBranch(branchName)

  // if (packageManager === 'pnpm') {
  //   await updatePnpmCatalog(depInfos, context.repo, targetDir)
  // }

  await updatePackageDependencies(packageManager, deps, context.repo, targetDir)

  if (!(await gitHelper.isNeedCommit())) {
    core.info('No changes to commit')
    return
  }

  core.startGroup('Changes to commit')
  await gitHelper.printDiff()
  core.endGroup()

  const title = customTitle || getPrTitle(depInfos)
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
