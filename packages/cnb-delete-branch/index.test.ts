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

describe('删除 CNB 分支', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  it('编码仓库路径时保留路径分隔符', () => {
    expect(encodePath('tdesign/workflows')).toBe('tdesign/workflows')
    expect(encodePath('tdesign/branch with space')).toBe('tdesign/branch%20with%20space')
  })

  it('发送 CNB JSON 请求头并解析 JSON 响应', async () => {
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

  it('请求失败时抛出 CNBRequestError', async () => {
    mockFetchOnce(403, JSON.stringify({ errmsg: 'forbidden' }), 'Forbidden')

    await expect(fetchCNB('token', '/tdesign/test/-/pulls')).rejects.toMatchObject({
      message: '[CNB] GET /tdesign/test/-/pulls failed: forbidden',
      status: 403,
    })
  })

  it('分页拉取 Pull Request 列表', async () => {
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

  it('通过 CNB Pull Request 接口更新 PR 状态', async () => {
    mockFetchOnce(200, '{}')

    await expect(patchPull('token', 'tdesign/test', '12', { state: 'closed' })).resolves.toBe(true)

    expect(fetch).toHaveBeenCalledWith('https://api.cnb.cool/tdesign/test/-/pulls/12', expect.objectContaining({
      body: JSON.stringify({ state: 'closed' }),
      method: 'PATCH',
    }))
  })

  it('分支不存在时视为成功跳过，其他删除失败继续抛出', async () => {
    mockFetchOnce(404, JSON.stringify({ errmsg: 'not found' }), 'Not Found')
    await expect(deleteBranch('token', 'tdesign/test', 'feature')).resolves.toBe(false)

    mockFetchOnce(403, JSON.stringify({ errmsg: 'forbidden' }), 'Forbidden')
    await expect(deleteBranch('token', 'tdesign/test', 'feature')).rejects.toBeInstanceOf(CNBRequestError)
  })

  it('head 数据缺失时安全读取 PR 分支和仓库', () => {
    expect(getPullBranchName(createPullRequest('1', 'refs/heads/feature/test'))).toBe('feature/test')
    expect(getPullRepoPath(createPullRequest('1'))).toBe('tdesign/test')
    expect(getPullBranchName({ head: null } as PullRequest)).toBeUndefined()
    expect(getPullRepoPath({ head: null } as PullRequest)).toBeUndefined()
  })
})
