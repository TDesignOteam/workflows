import * as core from '@actions/core'
import * as github from '@actions/github'

const COMMENTS_PER_PAGE = 100

export interface IssueComment {
  body?: string | null
  id: number
}

export interface IssuesApi {
  createComment: (params: { body: string, issue_number: number, owner: string, repo: string }) => Promise<{ data: IssueComment }>
  deleteComment: (params: { comment_id: number, owner: string, repo: string }) => Promise<unknown>
  listComments: (params: { issue_number: number, owner: string, page: number, per_page: number, repo: string }) => Promise<{ data: IssueComment[] }>
  updateComment: (params: { body: string, comment_id: number, owner: string, repo: string }) => Promise<{ data: IssueComment }>
}

export interface MaintainOneCommentOptions {
  body: string
  bodyInclude: string
  number: number
  owner: string
  repo: string
}

export function getCommentSelector(body: string, bodyInclude: string): string {
  const selector = bodyInclude || body
  if (!selector.trim())
    throw new Error('Missing comment selector')

  return selector
}

export function findMatchingComments(comments: IssueComment[], selector: string): IssueComment[] {
  return comments.filter(comment => (comment.body || '').includes(selector))
}

export async function listIssueComments(
  issues: IssuesApi,
  repoParams: { issue_number: number, owner: string, repo: string },
): Promise<IssueComment[]> {
  const comments: IssueComment[] = []

  for (let page = 1; ; page += 1) {
    const { data } = await issues.listComments({
      ...repoParams,
      page,
      per_page: COMMENTS_PER_PAGE,
    })
    comments.push(...data)

    if (data.length < COMMENTS_PER_PAGE)
      break
  }

  return comments
}

export async function maintainOneComment(
  issues: IssuesApi,
  options: MaintainOneCommentOptions,
): Promise<IssueComment> {
  const { body, number, owner, repo } = options
  const selector = getCommentSelector(body, options.bodyInclude)
  const comments = await listIssueComments(issues, {
    issue_number: number,
    owner,
    repo,
  })
  const matchedComments = findMatchingComments(comments, selector)

  core.info(`Matched comments: ${matchedComments.length}`)
  if (!matchedComments.length) {
    core.info(`Creating comment for #${number}`)
    const { data } = await issues.createComment({
      body,
      issue_number: number,
      owner,
      repo,
    })
    return data
  }

  const [targetComment, ...duplicateComments] = matchedComments
  if ((targetComment.body || '') !== body) {
    core.info(`Updating comment ${targetComment.id} for #${number}`)
    const { data } = await issues.updateComment({
      body,
      comment_id: targetComment.id,
      owner,
      repo,
    })
    for (const duplicateComment of duplicateComments) {
      core.info(`Deleting duplicate comment ${duplicateComment.id}`)
      await issues.deleteComment({
        comment_id: duplicateComment.id,
        owner,
        repo,
      })
    }
    return data
  }

  core.info(`Comment ${targetComment.id} is already up to date`)
  for (const duplicateComment of duplicateComments) {
    core.info(`Deleting duplicate comment ${duplicateComment.id}`)
    await issues.deleteComment({
      comment_id: duplicateComment.id,
      owner,
      repo,
    })
  }
  return targetComment
}

export async function main(): Promise<void> {
  const repo = core.getInput('repo') || github.context.repo.repo
  const owner = core.getInput('owner') || github.context.repo.owner
  const token = core.getInput('token', { required: true })
  const body = core.getInput('body', { required: true })
  const bodyInclude = core.getInput('body-include')
  const numberInput = core.getInput('number', { required: true })
  const number = Number.parseInt(numberInput, 10)

  if (!Number.isInteger(number) || number <= 0)
    throw new Error(`Invalid issue or pull request number "${numberInput}"`)

  core.startGroup('maintain-one-comment')
  core.info(`owner: ${owner}`)
  core.info(`repo: ${repo}`)
  core.info(`number: ${number}`)
  core.endGroup()

  const octokit = github.getOctokit(token)
  await maintainOneComment(octokit.rest.issues, {
    body,
    bodyInclude,
    number,
    owner,
    repo,
  })
}
