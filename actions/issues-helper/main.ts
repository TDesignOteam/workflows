import * as core from '@actions/core'
import * as github from '@actions/github'

type ActionName = 'create-comment' | 'update-issue' | 'mark-duplicate'
type Octokit = ReturnType<typeof github.getOctokit>
type ReactionContent = '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes'
type IssueState = 'closed' | 'open'
type CloseReason = 'completed' | 'not_planned'

const actionNames = new Set<ActionName>(['create-comment', 'update-issue', 'mark-duplicate'])
const reactionContents = new Set<ReactionContent>(['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes'])
const permissionRanks: Record<string, number> = {
  none: 0,
  read: 1,
  triage: 1,
  write: 2,
  maintain: 2,
  admin: 3,
}

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
  const repoInput = core.getInput('repo')
  if (repoInput) {
    const [owner, repo] = repoInput.split('/')
    if (!owner || !repo)
      throw new Error(`Invalid repo "${repoInput}"`)

    return { owner, repo }
  }

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

function getCloseReason(): CloseReason {
  return core.getInput('close-reason') === 'completed' ? 'completed' : 'not_planned'
}

function getIssueState(value: string | undefined): IssueState {
  return value === 'closed' ? 'closed' : 'open'
}

function getLabelNames(labels: Array<string | { name?: string | null }>): string[] {
  return labels
    .map(label => (typeof label === 'string' ? label : label.name || ''))
    .filter(Boolean)
}

function getAssigneeNames(assignees?: Array<{ login?: string | null }> | null): string[] {
  return (assignees || [])
    .map(assignee => assignee.login || '')
    .filter(Boolean)
}

function isDuplicateComment(body: string): boolean {
  const [duplicate, of] = body.split(' ')
  return duplicate?.toLowerCase() === 'duplicate' && of?.toLowerCase() === 'of'
}

function hasRequiredPermission(permission: string, requiredPermission: string): boolean {
  const requiredRank = permissionRanks[requiredPermission] ?? permissionRanks.write
  const permissionRank = permissionRanks[permission] ?? permissionRanks.none

  return permissionRank >= requiredRank
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
  const body = core.getInput('body')
  if (!body) {
    core.warning('[create-comment] body is empty')
    return
  }

  const { data: comment } = await octokit.rest.issues.createComment({
    ...getIssueParams(),
    body,
  })

  core.setOutput('comment-id', comment.id)
  await createCommentReactions(octokit, comment.id)
}

async function updateIssue(octokit: Octokit) {
  const params = getIssueParams()
  const title = core.getInput('title')
  const body = core.getInput('body')
  const state = core.getInput('state')
  const labels = splitInput(core.getInput('labels'))
  const assignees = splitInput(core.getInput('assignees'))
  const updateMode = core.getInput('update-mode') === 'append' ? 'append' : 'replace'
  const { data: issue } = await octokit.rest.issues.get(params)
  const nextBody = body
    ? updateMode === 'append'
      ? `${issue.body || ''}\n${body}`
      : body
    : issue.body || ''

  const nextState = state === 'closed' || state === 'open' ? state : getIssueState(issue.state)

  await octokit.rest.issues.update({
    ...params,
    assignees: assignees.length ? assignees : getAssigneeNames(issue.assignees),
    body: nextBody,
    labels: labels.length ? labels : getLabelNames(issue.labels),
    state: nextState,
    title: title || issue.title,
  })
}

async function setIssueLabels(octokit: Octokit, params: ReturnType<typeof getIssueParams>, labels: string[]) {
  const { data: issue } = await octokit.rest.issues.get(params)
  const baseLabels = getLabelNames(issue.labels)
  const nextLabels = [...new Set(labels)]
  const removeLabels = baseLabels.filter(label => !nextLabels.includes(label))
  const addLabels = nextLabels.filter(label => !baseLabels.includes(label))

  for (const label of removeLabels) {
    await octokit.rest.issues.removeLabel({
      ...params,
      name: label,
    })
  }

  if (addLabels.length) {
    await octokit.rest.issues.addLabels({
      ...params,
      labels: addLabels,
    })
  }
}

async function closeDuplicateIssue(octokit: Octokit, params: ReturnType<typeof getIssueParams>, isPullRequest: boolean) {
  if (isPullRequest) {
    await octokit.rest.pulls.update({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.issue_number,
      state: 'closed',
    })
    return
  }

  await octokit.rest.issues.update({
    ...params,
    state: 'closed',
    state_reason: getCloseReason(),
  })
}

async function markDuplicate(octokit: Octokit) {
  if (github.context.eventName !== 'issue_comment' || !['created', 'edited'].includes(String(github.context.payload.action))) {
    core.warning('[mark-duplicate] only supports issue_comment created/edited events')
    return
  }

  const comment = github.context.payload.comment as { body?: string, id?: number, user?: { login?: string } } | undefined
  const body = comment?.body || ''
  const duplicateCommand = core.getInput('duplicate-command')
  const isCommand = duplicateCommand && body.startsWith(duplicateCommand) && body.split(' ')[0] === duplicateCommand
  if (body.includes('?') || !(isCommand || isDuplicateComment(body))) {
    core.info('[mark-duplicate] comment is not a duplicate marker')
    return
  }

  const commentUser = comment?.user?.login
  if (!commentUser) {
    core.info('[mark-duplicate] missing commenter')
    return
  }

  const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
    ...getRepoParams(),
    username: commentUser,
  })
  const requiredPermission = core.getInput('require-permission') || 'write'
  if (!hasRequiredPermission(data.permission, requiredPermission)) {
    core.info(`[mark-duplicate] the user ${commentUser} is not allowed`)
    return
  }

  if (isCommand && comment?.id) {
    await octokit.rest.issues.updateComment({
      ...getRepoParams(),
      comment_id: comment.id,
      body: body.replace(duplicateCommand, 'Duplicate of'),
    })
    await createCommentReactions(octokit, comment.id)
  }
  else if (comment?.id) {
    await createCommentReactions(octokit, comment.id)
  }

  const params = getIssueParams()
  const { data: issue } = await octokit.rest.issues.get(params)
  const removeLabels = splitInput(core.getInput('remove-labels'))
  const duplicateLabels = splitInput(core.getInput('duplicate-labels') || 'duplicate')
  const labels = splitInput(core.getInput('labels'))
  const nextLabels = labels.length
    ? labels
    : [
        ...getLabelNames(issue.labels).filter(label => !removeLabels.includes(label)),
        ...duplicateLabels,
      ]

  if (nextLabels.length)
    await setIssueLabels(octokit, params, nextLabels)

  if (core.getInput('close-issue') === 'true') {
    await closeDuplicateIssue(octokit, params, Boolean(issue.pull_request))
  }

  core.info('[mark-duplicate] done')
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
  const octokit = github.getOctokit(core.getInput('token'))

  for (const action of getActions())
    await runAction(action, octokit)
}
