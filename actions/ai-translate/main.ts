import * as core from '@actions/core'
import * as github from '@actions/github'
import OpenAI from 'openai'

export const DEFAULT_BASE_URL = 'https://tokenhub.tencentmaas.com/v1'
export const DEFAULT_MODEL = 'hy-mt2-plus'
export const DEFAULT_PROMPT_TEMPLATE = '将以下文本翻译为 {targetLang}，注意只需要输出翻译后的结果，不要额外解释：\n{sourceText}'

export interface TranslateParams {
  model: string
  prompt: string
}

export interface ChatCompletionsApi {
  create: (params: { model: string, messages: { role: 'user', content: string }[] }) => Promise<{
    choices: { message?: { content?: string | null } }[]
  }>
}

export interface CreateClientOptions {
  apiKey: string
  baseURL?: string
}

export interface CreateCommentApi {
  createComment: (params: { body: string, issue_number: number, owner: string, repo: string }) => Promise<{ data: { id: number } }>
}

export interface PostCommentOptions {
  body: string
  issueNumber: number
  owner: string
  repo: string
}

export function buildPrompt(prompt: string | undefined, targetLang: string, sourceText: string): string {
  const template = prompt && prompt.trim() ? prompt : DEFAULT_PROMPT_TEMPLATE
  const result = template.replaceAll('{targetLang}', targetLang)

  return template.includes('{sourceText}')
    ? result.replaceAll('{sourceText}', sourceText)
    : `${result}：\n${sourceText}`
}

export function withTitle(title: string | undefined, translatedText: string): string {
  const trimmedTitle = title && title.trim() ? title.trim() : ''

  return trimmedTitle ? `# ${trimmedTitle}\n\n${translatedText}` : translatedText
}

export function parseIssueNumber(input: string): number | undefined {
  if (!input)
    return undefined

  const issueNumber = Number.parseInt(input, 10)
  if (!Number.isInteger(issueNumber) || issueNumber <= 0)
    throw new Error(`Invalid issue-number "${input}"`)

  return issueNumber
}

export async function translate(client: ChatCompletionsApi, params: TranslateParams): Promise<string> {
  const { model, prompt } = params

  const response = await client.create({
    model,
    messages: [{ role: 'user', content: prompt }],
  })

  const translatedText = response.choices[0]?.message?.content?.trim()
  if (!translatedText)
    throw new Error('Translation result is empty')

  return translatedText
}

export function createClient(options: CreateClientOptions): ChatCompletionsApi {
  const { apiKey, baseURL = DEFAULT_BASE_URL } = options
  const client = new OpenAI({ apiKey, baseURL })
  return client.chat.completions
}

export async function postComment(issues: CreateCommentApi, options: PostCommentOptions): Promise<number> {
  const { body, issueNumber, owner, repo } = options
  const { data } = await issues.createComment({
    body,
    issue_number: issueNumber,
    owner,
    repo,
  })
  return data.id
}

export async function main(): Promise<void> {
  const apiKey = core.getInput('api-key', { required: true })
  const baseURL = core.getInput('base-url') || DEFAULT_BASE_URL
  const model = core.getInput('model') || DEFAULT_MODEL
  const targetLang = core.getInput('target-lang', { required: true })
  const sourceText = core.getInput('source-text', { required: true })
  const prompt = core.getInput('prompt')
  const title = core.getInput('title')
  const issueNumber = parseIssueNumber(core.getInput('issue-number'))

  core.startGroup('ai-translate')
  core.info(`base-url: ${baseURL}`)
  core.info(`model: ${model}`)
  core.info(`target-lang: ${targetLang}`)
  core.info(`source-text length: ${sourceText.length}`)
  if (issueNumber)
    core.info(`issue-number: ${issueNumber}`)
  core.endGroup()

  const translatedText = await translate(createClient({ apiKey, baseURL }), {
    model,
    prompt: buildPrompt(prompt, targetLang, sourceText),
  })
  const content = withTitle(title, translatedText)
  core.info('Translation succeeded')
  core.setOutput('translated-text', content)

  if (!issueNumber)
    return

  const token = core.getInput('token')
  const owner = core.getInput('owner') || github.context.repo.owner
  const repo = core.getInput('repo') || github.context.repo.repo
  const octokit = github.getOctokit(token)
  const commentId = await postComment(octokit.rest.issues, {
    body: content,
    issueNumber,
    owner,
    repo,
  })
  core.info(`Comment created: ${commentId}`)
  core.setOutput('comment-id', String(commentId))
}
