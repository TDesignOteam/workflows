import * as core from '@actions/core'

const CNB_API_URL = 'https://api.cnb.cool'

interface PullRequest {
  number: number
  title: string
  body: string
  state: string
  head: {
    ref: string
    repo: { path: string }
  }
}

interface CNBResponse<T> {
  status: number
  data?: T
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

function encodePath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/')
}

async function fetchCNB<T>(
  token: string,
  path: string,
  options?: RequestInit,
): Promise<CNBResponse<T> | undefined> {
  const url = `${CNB_API_URL}/api/v1${path}`
  const method = options?.method || 'GET'
  core.info(`[CNB] ${method} ${path}`)

  const response = await fetch(url, {
    ...options,
    headers: {
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
    if (response.status === 500)
      throw new Error(requestMessage)
    core.warning(requestMessage)
    return undefined
  }

  core.info(`[CNB] ${method} ${path} succeeded: ${response.status}`)
  return {
    status: response.status,
    data: parseJson<T>(text),
  }
}

async function listPulls(token: string, repo: string, state: string): Promise<PullRequest[]> {
  const result = await fetchCNB<PullRequest[]>(token, `/${repo}/-/pulls?state=${state}`)
  return result?.data || []
}

async function patchPull(
  token: string,
  repo: string,
  number: number,
  data: { state: string, title: string, body: string },
): Promise<boolean> {
  const result = await fetchCNB(token, `/${repo}/-/pulls/${number}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
  return Boolean(result)
}

async function deleteBranch(token: string, repo: string, branch: string): Promise<boolean> {
  const result = await fetchCNB(token, `/${repo}/-/git/branches/${encodePath(branch)}`, {
    method: 'DELETE',
  })
  return Boolean(result)
}

async function main(): Promise<void> {
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
      pr => pr.head.ref.replace(/^refs\/heads\//, '') === branch && pr.head.repo.path === repo,
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
      const closed = await patchPull(token, repo, pr.number, { state: 'closed', title: pr.title, body: pr.body })
        .catch((e) => {
          core.warning(`Close PR #${pr.number} failed: ${e.message}`)
          return false
        })
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
      core.warning(`Branch "${branch}" was not deleted. It may not exist, or the token may not have access.`)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    core.setFailed(message)
  }
}

main().catch((error) => {
  core.setFailed(`cnb-delete-branch failed: ${error instanceof Error ? error.message : String(error)}`)
})
