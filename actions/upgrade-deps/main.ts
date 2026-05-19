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

export interface DependencyInfo {
  name: string
  version: string
}

const PACKAGE_MANAGER_COMMANDS = {
  pnpm: { cmd: 'pnpm', args: ['up', '--latest'] },
  yarn: { cmd: 'yarn', args: ['upgrade', '--latest'] },
  npm: { cmd: 'npm', args: ['install'] },
} as const

type PackageManager = keyof typeof PACKAGE_MANAGER_COMMANDS

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

export async function fetchPackageVersion(pkg: string): Promise<DependencyInfo> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${pkg}/latest`)
    if (!response.ok) {
      throw new Error(`status code: ${response.status}`)
    }
    const { version } = await response.json() as { version?: string }
    if (!version) {
      throw new Error('no version found')
    }
    core.info(`Latest version of ${pkg} is ${version}`)
    return { name: pkg, version }
  }
  catch (error) {
    throw new Error(`Failed to get ${pkg} info from npm registry: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function resolveDependencyInfos(deps: string[]): Promise<DependencyInfo[]> {
  return Promise.all(deps.map(fetchPackageVersion))
}

export async function updatePackageDependencies(packageManager: PackageManager, deps: string[], repo: string, targetDir: string): Promise<void> {
  const repoPath = getRepoPath(repo, targetDir)
  const { cmd, args } = PACKAGE_MANAGER_COMMANDS[packageManager]
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
  const packageManager = validatePackageManager(core.getInput('package-manager') || 'npm')
  const targetDir = core.getInput('target-dir') || ''
  const customTitle = core.getInput('title') || ''
  const deps = parseDependencyInputs(core.getMultilineInput('deps', { required: true, trimWhitespace: true }))

  core.info(`deps: ${JSON.stringify(deps)}`)
  core.info(`target-dir: ${targetDir || 'default (repo root)'}`)
  if (customTitle) {
    core.info(`custom-title: ${customTitle}`)
  }

  const depInfos = await resolveDependencyInfos(deps)
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
