import * as path from 'node:path'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import { GitHelper, GithubHelper } from '@workflows/utils'

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

const PACKAGE_MANAGER_COMMANDS: Record<string, { cmd: string, args: string[] }> = {
  pnpm: { cmd: 'pnpm', args: ['up', '--latest'] },
  yarn: { cmd: 'yarn', args: ['upgrade', '--latest'] },
  npm: { cmd: 'npm', args: ['update'] },
}

function getBranchName(deps: DependencyInfo[]): string {
  const depsSlug = deps.map(d => `${d.name.replace(/@/g, '').replace(/\//g, '-')}-${d.version}`).join('-')
  return `chore/deps/upgrade-${depsSlug}`
}

function getPrTitle(deps: DependencyInfo[]): string {
  const depList = deps.map(d => `${d.name} to ${d.version}`).join(', ')
  return `chore: upgrade ${depList}`
}

function getRepoPath(repo: string, targetDir: string): string {
  const base = `./${repo}`
  return targetDir ? path.join(base, targetDir) : base
}

async function fetchPackageVersion(pkg: string): Promise<DependencyInfo | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${pkg}/latest`)
    if (!response.ok) {
      core.error(`Failed to get ${pkg} info from npm registry, status code: ${response.status}`)
      return null
    }
    const { version } = await response.json() as { version?: string }
    if (!version) {
      core.error(`No version found for ${pkg}`)
      return null
    }
    core.info(`Latest version of ${pkg} is ${version}`)
    return { name: pkg, version }
  }
  catch (error) {
    core.error(`Error fetching ${pkg}: ${error}`)
    return null
  }
}

async function getPkgLatestVersions(pkgNames: string[]): Promise<DependencyInfo[]> {
  const results = await Promise.all(pkgNames.map(fetchPackageVersion))
  return results.filter((r): r is DependencyInfo => r !== null)
}

async function updatePackageDependencies(packageManager: string, deps: string[], repo: string, targetDir: string): Promise<void> {
  const repoPath = getRepoPath(repo, targetDir)
  const { cmd, args } = PACKAGE_MANAGER_COMMANDS[packageManager] ?? PACKAGE_MANAGER_COMMANDS.npm
  await exec.exec(cmd, [...args, ...deps], { cwd: repoPath })
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
    throw new Error('Missing deps input')
  }

  const depInfos = await getPkgLatestVersions(deps)
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
  const branchName = getBranchName(depInfos)
  await gitHelper.createBranch(branchName)

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
