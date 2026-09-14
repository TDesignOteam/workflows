import type { TriggerContext } from './types'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import { GitHelper, GithubHelper } from '@workflows/utils'
import { getBranchName, getPrTitle, parseDependencyInputs, resolveDependencyInfos, validatePackageManager } from './dependencies'
import { readPullRequestTemplate, resolveDependencyReleases } from './github'
import { buildPullRequestBody } from './pull-request'
import { updatePackageDependencies } from './workspace'

export * from './dependencies'
export * from './github'
export * from './pull-request'
export * from './types'
export * from './workspace'

export async function updateDependencies(context: TriggerContext): Promise<void> {
  const packageManager = validatePackageManager(core.getInput('package-manager') || 'npm')
  const targetDir = core.getInput('target-dir') || ''
  const customTitle = core.getInput('title') || ''
  const deps = parseDependencyInputs(core.getMultilineInput('deps', { required: true, trimWhitespace: true }))
  let depInfos = await resolveDependencyInfos(deps)
  if (packageManager !== 'npm')
    await exec.exec('corepack', ['enable'])
  const gitHelper = new GitHelper({ repo: context.repo, owner: context.owner, token: context.token, dryRun: context.dryRun })
  const baseBranch = await gitHelper.clone()
  await gitHelper.initSubmodule()
  const template = await readPullRequestTemplate(`./${context.repo}`)
  depInfos = await resolveDependencyReleases(depInfos, context.token)
  const branchName = getBranchName(depInfos)
  await gitHelper.createBranch(branchName)
  await updatePackageDependencies(packageManager, depInfos, context.repo, targetDir)
  if (!(await gitHelper.isNeedCommit())) {
    core.info('No changes to commit')
    return
  }
  core.startGroup('Dependency diff')
  try {
    await gitHelper.printDiff()
  }
  finally {
    core.endGroup()
  }
  const title = customTitle || getPrTitle(depInfos)
  const body = buildPullRequestBody(template, depInfos, context.repo)
  await gitHelper.commit(title)
  await gitHelper.push(branchName)
  const githubHelper = new GithubHelper({ owner: context.owner, repo: context.repo, token: context.token, dryRun: context.dryRun })
  await githubHelper.createPR(title, branchName, body, baseBranch)
}

export async function main(): Promise<void> {
  const repo = core.getInput('repo') || github.context.repo.repo
  const owner = core.getInput('owner') || github.context.repo.owner
  const token = core.getInput('token', { required: true })
  await updateDependencies({ repo, owner, token, dryRun: core.getBooleanInput('dry-run') })
}
