import type { PullRequest } from './types'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import * as core from '@actions/core'

const CNB_API_URL = 'https://api.cnb.cool'
const PULL_PAGE_SIZE = 100

interface CNBResponse<T> {
  status: number
  data?: T
}

export class CNBRequestError extends Error {
  constructor(message: string, public status: number) {
    super(message)
    this.name = 'CNBRequestError'
  }
}

function parseJson<T>(text: string): T | undefined {
  if (!text)
    return undefined

  try {
    return JSON.parse(text) as T
  }
  catch {
    return undefined
  }
}

export function encodePath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/')
}

export function getPullRepoPath(pr: PullRequest): string | undefined {
  return pr.head?.repo?.path
}

export function getPullBranchName(pr: PullRequest): string | undefined {
  return pr.head?.ref?.replace(/^refs\/heads\//, '')
}

export async function fetchCNB<T>(
  token: string,
  path: string,
  options?: RequestInit,
): Promise<CNBResponse<T>> {
  const url = `${CNB_API_URL}${path}`
  const method = options?.method || 'GET'
  core.info(`[CNB] ${method} ${path}`)

  const response = await fetch(url, {
    ...options,
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
  const text = await response.text()

  if (!response.ok) {
    const err = parseJson<{ errcode?: number, errmsg?: string }>(text)
    const message = err?.errmsg || `CNB API ${response.status}: ${response.statusText}`
    const requestMessage = `[CNB] ${method} ${path} failed: ${message}`
    throw new CNBRequestError(requestMessage, response.status)
  }

  core.info(`[CNB] ${method} ${path} succeeded: ${response.status}`)
  return {
    status: response.status,
    data: parseJson<T>(text),
  }
}

export async function listPulls(token: string, repo: string, state: string): Promise<PullRequest[]> {
  const pulls: PullRequest[] = []

  for (let page = 1; ; page += 1) {
    const params = new URLSearchParams({
      state,
      page: String(page),
      page_size: String(PULL_PAGE_SIZE),
    })
    const result = await fetchCNB<PullRequest[]>(token, `/${encodePath(repo)}/-/pulls?${params.toString()}`)
    const pagePulls = result.data || []
    pulls.push(...pagePulls)

    if (pagePulls.length < PULL_PAGE_SIZE)
      break
  }

  return pulls
}

export async function patchPull(
  token: string,
  repo: string,
  number: string,
  data: { state: string },
): Promise<boolean> {
  const result = await fetchCNB(token, `/${encodePath(repo)}/-/pulls/${encodeURIComponent(number)}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
  return Boolean(result)
}

export async function deleteBranch(token: string, repo: string, branch: string): Promise<boolean> {
  try {
    await fetchCNB(token, `/${encodePath(repo)}/-/git/branches/${encodePath(branch)}`, {
      method: 'DELETE',
    })
    return true
  }
  catch (error) {
    if (error instanceof CNBRequestError && error.status === 404)
      return false

    throw error
  }
}

export async function main(): Promise<void> {
  const repo = core.getInput('repo', { required: true })
  const branch = core.getInput('branch', { required: true })
  const token = core.getInput('token', { required: true })

  core.startGroup('cnb-delete-branch')
  core.info(`Repo: ${repo}`)
  core.info(`Branch: ${branch}`)
  core.endGroup()

  try {
    core.info('Step 1/4: list open pull requests')
    const prs = await listPulls(token, repo, 'open')
    core.info(`Open pull requests: ${prs.length}`)

    core.info('Step 2/4: find pull requests from target branch')
    const branchPRs = prs.filter(
      (pr) => {
        const headRepo = getPullRepoPath(pr)
        const headBranch = getPullBranchName(pr)
        return headBranch === branch && (!headRepo || headRepo === repo)
      },
    )
    if (branchPRs.length) {
      core.info(`Matched pull requests: ${branchPRs.map(pr => `#${pr.number}`).join(', ')}`)
    }
    else {
      core.info(`No open pull requests found for branch "${branch}"`)
    }

    core.info('Step 3/4: close matched pull requests')
    for (const pr of branchPRs) {
      core.info(`Closing PR #${pr.number}: ${pr.title}`)
      const closed = await patchPull(token, repo, pr.number, { state: 'closed' })
      if (closed)
        core.info(`PR #${pr.number} closed`)
    }
    if (!branchPRs.length)
      core.info('Skip closing pull requests')

    core.info('Step 4/4: delete target branch')
    const deleted = await deleteBranch(token, repo, branch)
    if (deleted)
      core.info(`Branch "${branch}" deleted`)
    else
      core.info(`Branch "${branch}" does not exist; skip delete`)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    core.setFailed(message)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    core.setFailed(`cnb-delete-branch failed: ${error instanceof Error ? error.message : String(error)}`)
  })
}
