import * as core from '@actions/core'
import * as github from '@actions/github'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildPrompt,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_PROMPT_TEMPLATE,
  main,
  parseIssueNumber,
  postComment,
  translate,
  withTitle,
} from './main'

vi.mock('@actions/core', () => ({
  endGroup: vi.fn(),
  getInput: vi.fn(),
  info: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
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

vi.mock('openai', () => ({
  default: class MockOpenAI {
    constructor(public options: { apiKey: string, baseURL?: string }) {}

    chat = {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: 'Please make sure all attendees have received the agenda before the meeting starts.' } }],
        }),
      },
    }
  },
}))

const TRANSLATED_TEXT = 'Please make sure all attendees have received the agenda before the meeting starts.'

function createClient() {
  return {
    create: vi.fn().mockResolvedValue({
      choices: [{ message: { content: 'translated text' } }],
    }),
  }
}

function mockInputs(overrides: Record<string, string> = {}) {
  vi.mocked(core.getInput).mockImplementation((name: string) => {
    const inputs: Record<string, string> = {
      'api-key': 'test-api-key',
      'base-url': '',
      'model': '',
      'target-lang': '英语',
      'source-text': '会议开始前请确认所有参会人员都收到了议程。',
      'prompt': '',
      'title': '',
      'issue-number': '',
      'token': 'gh-token',
      'owner': '',
      'repo': '',
      ...overrides,
    }
    return inputs[name] ?? ''
  })
}

function mockOctokit() {
  const createComment = vi.fn().mockResolvedValue({ data: { id: 4242 } })
  vi.mocked(github.getOctokit).mockReturnValue({
    rest: {
      issues: { createComment },
    },
  } as unknown as ReturnType<typeof github.getOctokit>)
  return createComment
}

describe('ai-translate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(github.getOctokit).mockReset()
    mockInputs()
  })

  it('默认模板拼接 prompt', () => {
    expect(buildPrompt(undefined, '英语', '你好')).toBe(
      '将以下文本翻译为 英语，注意只需要输出翻译后的结果，不要额外解释：\n你好',
    )
    expect(buildPrompt('', '英语', '你好')).toBe(DEFAULT_PROMPT_TEMPLATE.replaceAll('{targetLang}', '英语').replaceAll('{sourceText}', '你好'))
    expect(buildPrompt('   ', '英语', '你好')).toBe(
      '将以下文本翻译为 英语，注意只需要输出翻译后的结果，不要额外解释：\n你好',
    )
  })

  it('自定义 prompt 支持占位符', () => {
    expect(buildPrompt('Translate the text below to {targetLang}:\n{sourceText}', 'English', 'hello')).toBe(
      'Translate the text below to English:\nhello',
    )
    expect(buildPrompt('翻译为{targetLang}', '英语', '你好')).toBe('翻译为英语：\n你好')
  })

  it('自定义 prompt 无占位符时追加原文', () => {
    expect(buildPrompt('你是一个专业译员，请忠实地完成翻译任务', '英语', '你好')).toBe(
      '你是一个专业译员，请忠实地完成翻译任务：\n你好',
    )
  })

  it('withTitle 拼接标题头', () => {
    expect(withTitle('会议确认', TRANSLATED_TEXT)).toBe(`# 会议确认\n\n${TRANSLATED_TEXT}`)
    expect(withTitle('  会议确认  ', TRANSLATED_TEXT)).toBe(`# 会议确认\n\n${TRANSLATED_TEXT}`)
    expect(withTitle(undefined, TRANSLATED_TEXT)).toBe(TRANSLATED_TEXT)
    expect(withTitle('', TRANSLATED_TEXT)).toBe(TRANSLATED_TEXT)
    expect(withTitle('   ', TRANSLATED_TEXT)).toBe(TRANSLATED_TEXT)
  })

  it('parseIssueNumber 校验 issue 编号', () => {
    expect(parseIssueNumber('')).toBeUndefined()
    expect(parseIssueNumber('42')).toBe(42)
    expect(() => parseIssueNumber('abc')).toThrow('Invalid issue-number "abc"')
    expect(() => parseIssueNumber('0')).toThrow('Invalid issue-number "0"')
    expect(() => parseIssueNumber('-1')).toThrow('Invalid issue-number "-1"')
  })

  it('调用 chat.completions 并返回译文', async () => {
    const client = createClient()

    await expect(translate(client, { model: 'hy-mt2-plus', prompt: 'prompt' })).resolves.toBe('translated text')

    expect(client.create).toHaveBeenCalledWith({
      model: 'hy-mt2-plus',
      messages: [{ role: 'user', content: 'prompt' }],
    })
  })

  it('译文为空时抛错', async () => {
    const client = createClient()
    client.create.mockResolvedValueOnce({ choices: [{ message: { content: '' } }] })
    await expect(translate(client, { model: 'hy-mt2-plus', prompt: 'prompt' })).rejects.toThrow('Translation result is empty')

    client.create.mockResolvedValueOnce({ choices: [{ message: { content: null } }] })
    await expect(translate(client, { model: 'hy-mt2-plus', prompt: 'prompt' })).rejects.toThrow('Translation result is empty')

    client.create.mockResolvedValueOnce({ choices: [] })
    await expect(translate(client, { model: 'hy-mt2-plus', prompt: 'prompt' })).rejects.toThrow('Translation result is empty')
  })

  it('postComment 创建评论并返回评论 ID', async () => {
    const issues = {
      createComment: vi.fn().mockResolvedValue({ data: { id: 4242 } }),
    }

    await expect(postComment(issues, {
      body: 'body',
      issueNumber: 12,
      owner: 'Tencent',
      repo: 'workflows',
    })).resolves.toBe(4242)

    expect(issues.createComment).toHaveBeenCalledWith({
      body: 'body',
      issue_number: 12,
      owner: 'Tencent',
      repo: 'workflows',
    })
  })

  it('main 使用默认 base-url 和 model 并输出译文', async () => {
    await main()

    expect(core.startGroup).toHaveBeenCalledWith('ai-translate')
    expect(core.info).toHaveBeenCalledWith(`base-url: ${DEFAULT_BASE_URL}`)
    expect(core.info).toHaveBeenCalledWith(`model: ${DEFAULT_MODEL}`)
    expect(core.info).not.toHaveBeenCalledWith(expect.stringContaining('test-api-key'))
    expect(core.setOutput).toHaveBeenCalledWith('translated-text', TRANSLATED_TEXT)
    expect(github.getOctokit).not.toHaveBeenCalled()
    expect(core.setOutput).not.toHaveBeenCalledWith('comment-id', expect.anything())
  })

  it('main 未提供 issue-number 时不发评论', async () => {
    mockInputs({ title: '会议确认' })
    await main()

    expect(github.getOctokit).not.toHaveBeenCalled()
    expect(core.setOutput).toHaveBeenCalledWith('translated-text', `# 会议确认\n\n${TRANSLATED_TEXT}`)
  })

  it('main 提供标题头和 issue-number 时发评论', async () => {
    const createComment = mockOctokit()
    mockInputs({ 'title': '会议确认', 'issue-number': '12', 'owner': 'Tencent', 'repo': 'tdesign' })

    await main()

    const content = `# 会议确认\n\n${TRANSLATED_TEXT}`
    expect(github.getOctokit).toHaveBeenCalledWith('gh-token')
    expect(createComment).toHaveBeenCalledWith({
      body: content,
      issue_number: 12,
      owner: 'Tencent',
      repo: 'tdesign',
    })
    expect(core.setOutput).toHaveBeenCalledWith('translated-text', content)
    expect(core.setOutput).toHaveBeenCalledWith('comment-id', '4242')
  })

  it('main 未提供 owner/repo 时使用当前仓库', async () => {
    const createComment = mockOctokit()
    mockInputs({ 'issue-number': '12' })

    await main()

    expect(createComment).toHaveBeenCalledWith({
      body: TRANSLATED_TEXT,
      issue_number: 12,
      owner: 'Tencent',
      repo: 'workflows',
    })
  })

  it('main 提供非法 issue-number 时抛错', async () => {
    mockInputs({ 'issue-number': 'abc' })

    await expect(main()).rejects.toThrow('Invalid issue-number "abc"')
    expect(github.getOctokit).not.toHaveBeenCalled()
  })
})
