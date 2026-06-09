import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  findMatchingComments,
  getCommentSelector,
  listIssueComments,
  maintainOneComment,
} from './main'

vi.mock('@actions/core', () => ({
  endGroup: vi.fn(),
  getInput: vi.fn(),
  info: vi.fn(),
  setFailed: vi.fn(),
  startGroup: vi.fn(),
}))

vi.mock('@actions/github', () => ({
  context: {
    repo: {
      owner: 'Tencent',
      repo: 'workflows',
    },
  },
  getOctokit: vi.fn(),
}))

describe('maintain-one-comment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('优先使用 body-include 作为选择器', () => {
    expect(getCommentSelector('body', '<!-- marker -->')).toBe('<!-- marker -->')
    expect(getCommentSelector('body', '')).toBe('body')
    expect(getCommentSelector('body <!-- tdesign-maintain-one-comment -->')).toBe('<!-- tdesign-maintain-one-comment -->')
  })

  it('按标记匹配评论', () => {
    expect(findMatchingComments([
      { body: 'hello <!-- marker -->', id: 1 },
      { body: 'world', id: 2 },
      { body: null, id: 3 },
    ], '<!-- marker -->')).toEqual([
      { body: 'hello <!-- marker -->', id: 1 },
    ])
  })

  it('分页拉取所有评论', async () => {
    const issues = {
      createComment: vi.fn(),
      deleteComment: vi.fn(),
      listComments: vi
        .fn()
        .mockResolvedValueOnce({
          data: Array.from({ length: 100 }, (_, index) => ({
            body: `comment-${index + 1}`,
            id: index + 1,
          })),
        })
        .mockResolvedValueOnce({
          data: [{ body: 'comment-101', id: 101 }],
        }),
      updateComment: vi.fn(),
    }

    await expect(listIssueComments(issues, {
      issue_number: 1,
      owner: 'Tencent',
      repo: 'workflows',
    })).resolves.toHaveLength(101)

    expect(issues.listComments).toHaveBeenNthCalledWith(1, {
      issue_number: 1,
      owner: 'Tencent',
      page: 1,
      per_page: 100,
      repo: 'workflows',
    })
    expect(issues.listComments).toHaveBeenNthCalledWith(2, {
      issue_number: 1,
      owner: 'Tencent',
      page: 2,
      per_page: 100,
      repo: 'workflows',
    })
  })

  it('没有匹配评论时创建新评论', async () => {
    const issues = {
      createComment: vi.fn().mockResolvedValue({ data: { body: 'new body', id: 9 } }),
      deleteComment: vi.fn(),
      listComments: vi.fn().mockResolvedValue({ data: [] }),
      updateComment: vi.fn(),
    }

    await expect(maintainOneComment(issues, {
      body: 'new body',
      bodyInclude: '<!-- marker -->',
      number: 12,
      owner: 'Tencent',
      repo: 'workflows',
    })).resolves.toEqual({ body: 'new body', id: 9 })

    expect(issues.createComment).toHaveBeenCalledWith({
      body: 'new body',
      issue_number: 12,
      owner: 'Tencent',
      repo: 'workflows',
    })
  })

  it('未传 bodyInclude 时使用默认标记匹配评论', async () => {
    const issues = {
      createComment: vi.fn(),
      deleteComment: vi.fn(),
      listComments: vi.fn().mockResolvedValue({
        data: [
          { body: 'old <!-- tdesign-maintain-one-comment -->', id: 3 },
        ],
      }),
      updateComment: vi.fn().mockResolvedValue({ data: { body: 'new <!-- tdesign-maintain-one-comment -->', id: 3 } }),
    }

    await expect(maintainOneComment(issues, {
      body: 'new <!-- tdesign-maintain-one-comment -->',
      number: 12,
      owner: 'Tencent',
      repo: 'workflows',
    })).resolves.toEqual({ body: 'new <!-- tdesign-maintain-one-comment -->', id: 3 })

    expect(issues.updateComment).toHaveBeenCalledWith({
      body: 'new <!-- tdesign-maintain-one-comment -->',
      comment_id: 3,
      owner: 'Tencent',
      repo: 'workflows',
    })
  })

  it('更新首个匹配评论并删除重复评论', async () => {
    const issues = {
      createComment: vi.fn(),
      deleteComment: vi.fn().mockResolvedValue(undefined),
      listComments: vi.fn().mockResolvedValue({
        data: [
          { body: 'old <!-- marker -->', id: 3 },
          { body: 'other', id: 4 },
          { body: 'duplicate <!-- marker -->', id: 5 },
        ],
      }),
      updateComment: vi.fn().mockResolvedValue({ data: { body: 'new <!-- marker -->', id: 3 } }),
    }

    await expect(maintainOneComment(issues, {
      body: 'new <!-- marker -->',
      bodyInclude: '<!-- marker -->',
      number: 12,
      owner: 'Tencent',
      repo: 'workflows',
    })).resolves.toEqual({ body: 'new <!-- marker -->', id: 3 })

    expect(issues.updateComment).toHaveBeenCalledWith({
      body: 'new <!-- marker -->',
      comment_id: 3,
      owner: 'Tencent',
      repo: 'workflows',
    })
    expect(issues.deleteComment).toHaveBeenCalledWith({
      comment_id: 5,
      owner: 'Tencent',
      repo: 'workflows',
    })
  })

  it('内容未变化时跳过更新但仍清理重复评论', async () => {
    const issues = {
      createComment: vi.fn(),
      deleteComment: vi.fn().mockResolvedValue(undefined),
      listComments: vi.fn().mockResolvedValue({
        data: [
          { body: 'same <!-- marker -->', id: 3 },
          { body: 'duplicate <!-- marker -->', id: 5 },
        ],
      }),
      updateComment: vi.fn(),
    }

    await expect(maintainOneComment(issues, {
      body: 'same <!-- marker -->',
      bodyInclude: '<!-- marker -->',
      number: 12,
      owner: 'Tencent',
      repo: 'workflows',
    })).resolves.toEqual({ body: 'same <!-- marker -->', id: 3 })

    expect(issues.updateComment).not.toHaveBeenCalled()
    expect(issues.deleteComment).toHaveBeenCalledWith({
      comment_id: 5,
      owner: 'Tencent',
      repo: 'workflows',
    })
  })
})
