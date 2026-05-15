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

async function fetchCNB<T>(
  token: string,
  path: string,
  options?: RequestInit,
): Promise<T | undefined> {
  const url = `${CNB_API_URL}/api/v1${path}`
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })

  if (!response.ok) {
    const err = await response.json().catch(() => undefined) as { errcode?: number, errmsg?: string }
    const message = err?.errmsg || `CNB API ${response.status}: ${response.statusText}`
    if (response.status === 500)
      throw new Error(message)
    core.warning(message)
    return undefined
  }

  return response.json() as Promise<T>
}

async function listPulls(token: string, repo: string, state: string): Promise<PullRequest[]> {
  const result = await fetchCNB<PullRequest[]>(token, `/${repo}/-/pulls?state=${state}`)
  return result || []
}

async function patchPull(
  token: string,
  repo: string,
  number: number,
  data: { state: string, title: string, body: string },
): Promise<void> {
  await fetchCNB(token, `/${repo}/-/pulls/${number}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

async function deleteBranch(token: string, repo: string, branch: string): Promise<void> {
  await fetchCNB(token, `/${repo}/-/git/branches/${encodeURIComponent(branch)}`, {
    method: 'DELETE',
  })
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
    const prs = await listPulls(token, repo, 'open')
    const branchPRs = prs.filter(
      pr => pr.head.ref.replace(/^refs\/heads\//, '') === branch && pr.head.repo.path === repo,
    )

    for (const pr of branchPRs) {
      await patchPull(token, repo, pr.number, { state: 'closed', title: pr.title, body: pr.body })
        .catch(e => core.warning(`PR #${pr.number}: ${e.message}`))
    }

    await deleteBranch(token, repo, branch)
    core.info(`Branch "${branch}" deleted`)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    core.setFailed(message)
  }
}

main().catch((error) => {
  core.setFailed(`cnb-delete-branch failed: ${error instanceof Error ? error.message : String(error)}`)
})
