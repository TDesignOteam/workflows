import * as core from '@actions/core'
import * as github from '@actions/github'

type ActionName = 'create-comment' | 'update-issue' | 'mark-duplicate'
type Octokit = ReturnType<typeof github.getOctokit>
type ReactionContent = '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes'

const actionNames = new Set<ActionName>(['create-comment', 'update-issue', 'mark-duplicate'])
const reactionContents = new Set<ReactionContent>(['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes'])
const duplicateAuthorAssociations = new Set(['COLLABORATOR', 'MEMBER', 'OWNER'])

function splitInput(value: string): string[] {
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

function getActions(): ActionName[] {
  return splitInput(core.getInput('actions', { required: true })).map((action) => {
    if (!actionNames.has(action as ActionName))
      throw new Error(`Unsupported action "${action}"`)

    return action as ActionName
  })
}

function getRepoParams() {
  return {
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
  }
}

function getIssueNumber(): number {
  const issueNumberInput = core.getInput('issue-number')
  const issueNumber = issueNumberInput ? Number.parseInt(issueNumberInput, 10) : github.context.issue.number

  if (!Number.isInteger(issueNumber) || issueNumber <= 0)
    throw new Error('Missing issue number')

  return issueNumber
}

function getIssueParams() {
  return {
    ...getRepoParams(),
    issue_number: getIssueNumber(),
  }
}

function isReactionContent(value: string): value is ReactionContent {
  return reactionContents.has(value as ReactionContent)
}

async function createCommentReactions(octokit: Octokit, commentId: number) {
  const reactions = splitInput(core.getInput('emoji'))
  if (!reactions.length)
    return

  for (const content of reactions) {
    if (!isReactionContent(content)) {
      core.warning(`[create-comment] unsupported emoji "${content}"`)
      continue
    }

    await octokit.rest.reactions.createForIssueComment({
      ...getRepoParams(),
      comment_id: commentId,
      content,
    })
  }
}

async function createComment(octokit: Octokit) {
  const body = core.getInput('body', { required: true })
  const { data: comment } = await octokit.rest.issues.createComment({
    ...getIssueParams(),
    body,
  })

  core.setOutput('comment-id', comment.id)
  await createCommentReactions(octokit, comment.id)
}

async function updateIssue(octokit: Octokit) {
  const params = getIssueParams()
  const body = core.getInput('body', { required: true })
  const updateMode = core.getInput('update-mode') === 'append' ? 'append' : 'replace'
  let nextBody = body

  if (updateMode === 'append') {
    const { data: issue } = await octokit.rest.issues.get(params)
    nextBody = issue.body ? `${issue.body}\n${body}` : body
  }

  await octokit.rest.issues.update({
    ...params,
    body: nextBody,
  })
}

async function markDuplicate(octokit: Octokit) {
  if (github.context.eventName !== 'issue_comment' || !['created', 'edited'].includes(String(github.context.payload.action))) {
    core.warning('[mark-duplicate] only supports issue_comment created/edited events')
    return
  }

  const comment = github.context.payload.comment as { author_association?: string, body?: string } | undefined
  const body = comment?.body || ''
  if (!/[Dd]uplicate\s+of\s+#\d+/.test(body)) {
    core.info('[mark-duplicate] comment is not a duplicate marker')
    return
  }

  const authorAssociation = comment?.author_association || ''
  if (!duplicateAuthorAssociations.has(authorAssociation)) {
    core.info(`[mark-duplicate] skipping commenter association "${authorAssociation}"`)
    return
  }

  const params = getIssueParams()
  const duplicateLabels = splitInput(core.getInput('duplicate-labels') || 'duplicate')
  if (duplicateLabels.length) {
    await octokit.rest.issues.addLabels({
      ...params,
      labels: duplicateLabels,
    })
  }

  if (core.getBooleanInput('close-issue')) {
    await octokit.rest.issues.update({
      ...params,
      state: 'closed',
    })
  }
}

async function runAction(action: ActionName, octokit: Octokit) {
  switch (action) {
    case 'create-comment':
      await createComment(octokit)
      break
    case 'update-issue':
      await updateIssue(octokit)
      break
    case 'mark-duplicate':
      await markDuplicate(octokit)
      break
  }
}

export async function main(): Promise<void> {
  const octokit = github.getOctokit(core.getInput('token', { required: true }))

  for (const action of getActions())
    await runAction(action, octokit)
}
