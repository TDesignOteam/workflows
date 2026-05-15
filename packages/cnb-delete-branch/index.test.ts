import type { PullRequest } from './types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CNBRequestError,
  deleteBranch,
  encodePath,
  fetchCNB,
  getPullBranchName,
  getPullRepoPath,
  listPulls,
  patchPull,
} from './index'

vi.mock('@actions/core', () => ({
  endGroup: vi.fn(),
  getInput: vi.fn(),
  info: vi.fn(),
  setFailed: vi.fn(),
  startGroup: vi.fn(),
}))

function mockFetchOnce(status: number, body = '', statusText = ''): void {
  vi.mocked(fetch).mockResolvedValueOnce(new Response(body, { status, statusText }))
}

function createPullRequest(number: string, ref = 'refs/heads/feature', repo = 'tdesign/test'): PullRequest {
  return {
    assignees: [],
    author: {} as PullRequest['author'],
    base: null,
    blocked_on: '',
    body: '',
    comment_count: 0,
    created_at: '',
    head: {
      ref,
      repo: {
        id: repo,
        name: repo.split('/').at(-1) || repo,
        path: repo,
        web_url: '',
      },
      sha: '',
    },
    is_wip: false,
    labels: [],
    last_acted_at: '',
    mergeable_state: '',
    merged_by: {} as PullRequest['merged_by'],
    number,
    repo: {} as PullRequest['repo'],
    review_count: 0,
    state: 'open',
    title: `PR ${number}`,
    updated_at: '',
  }
}

describe('cnb-delete-branch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  it('encodes repo paths but preserves path separators', () => {
    expect(encodePath('tdesign/workflows')).toBe('tdesign/workflows')
    expect(encodePath('tdesign/branch with space')).toBe('tdesign/branch%20with%20space')
  })

  it('sends CNB JSON headers and parses JSON responses', async () => {
    mockFetchOnce(200, JSON.stringify({ ok: true }))

    await expect(fetchCNB('token', '/tdesign/test/-/pulls')).resolves.toEqual({
      status: 200,
      data: { ok: true },
    })

    expect(fetch).toHaveBeenCalledWith('https://api.cnb.cool/tdesign/test/-/pulls', {
      headers: {
        'Accept': 'application/json',
        'Authorization': 'Bearer token',
        'Content-Type': 'application/json',
      },
    })
  })

  it('throws CNBRequestError for failed API responses', async () => {
    mockFetchOnce(403, JSON.stringify({ errmsg: 'forbidden' }), 'Forbidden')

    await expect(fetchCNB('token', '/tdesign/test/-/pulls')).rejects.toMatchObject({
      message: '[CNB] GET /tdesign/test/-/pulls failed: forbidden',
      status: 403,
    })
  })

  it('lists pull requests across pages', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => createPullRequest(String(index + 1)))
    const secondPage = [createPullRequest('101')]
    mockFetchOnce(200, JSON.stringify(firstPage))
    mockFetchOnce(200, JSON.stringify(secondPage))

    const pulls = await listPulls('token', 'tdesign/test', 'open')

    expect(pulls).toHaveLength(101)
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://api.cnb.cool/tdesign/test/-/pulls?state=open&page=1&page_size=100',
      expect.any(Object),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://api.cnb.cool/tdesign/test/-/pulls?state=open&page=2&page_size=100',
      expect.any(Object),
    )
  })

  it('patches pull request state through the CNB pull endpoint', async () => {
    mockFetchOnce(200, '{}')

    await expect(patchPull('token', 'tdesign/test', '12', { state: 'closed' })).resolves.toBe(true)

    expect(fetch).toHaveBeenCalledWith('https://api.cnb.cool/tdesign/test/-/pulls/12', expect.objectContaining({
      body: JSON.stringify({ state: 'closed' }),
      method: 'PATCH',
    }))
  })

  it('treats missing branch as a successful no-op but rethrows other delete failures', async () => {
    mockFetchOnce(404, JSON.stringify({ errmsg: 'not found' }), 'Not Found')
    await expect(deleteBranch('token', 'tdesign/test', 'feature')).resolves.toBe(false)

    mockFetchOnce(403, JSON.stringify({ errmsg: 'forbidden' }), 'Forbidden')
    await expect(deleteBranch('token', 'tdesign/test', 'feature')).rejects.toBeInstanceOf(CNBRequestError)
  })

  it('reads pull branch and repo safely when head data is missing', () => {
    expect(getPullBranchName(createPullRequest('1', 'refs/heads/feature/test'))).toBe('feature/test')
    expect(getPullRepoPath(createPullRequest('1'))).toBe('tdesign/test')
    expect(getPullBranchName({ head: null } as PullRequest)).toBeUndefined()
    expect(getPullRepoPath({ head: null } as PullRequest)).toBeUndefined()
  })
})
