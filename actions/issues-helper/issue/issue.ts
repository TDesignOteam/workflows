import type {
  IIssueBaseInfo,
  IIssueCoreEngine,
  IListIssuesParams,
  TCloseReason,
  TCommentList,
  TEmoji,
  TIssueInfo,
  TIssueList,
  TIssueState,
  TLockReasons,
  TUpdateMode,
  TUserPermission,
} from '../types'
import * as github from '@actions/github'
import { EEmoji } from '../const'

function ensureIssueNumber(issueNumber: number | undefined): number {
  if (!issueNumber) {
    throw new Error('Missing issue number')
  }
  return issueNumber
}

export class IssueCoreEngine implements IIssueCoreEngine {
  private owner!: string
  private repo!: string
  private issueNumber?: number
  private octokit!: ReturnType<typeof github.getOctokit>

  public constructor(info: IIssueBaseInfo) {
    if (!info.owner || !info.repo) {
      throw new Error('Init failed, need owner and repo')
    }

    this.owner = info.owner
    this.repo = info.repo
    this.issueNumber = info.issueNumber
    this.octokit = github.getOctokit(info.token)
  }

  public setIssueNumber(newIssueNumber: number) {
    this.issueNumber = newIssueNumber
  }

  public async addAssignees(assignees: string[]) {
    await this.octokit.rest.issues.addAssignees({
      owner: this.owner,
      repo: this.repo,
      issue_number: ensureIssueNumber(this.issueNumber),
      assignees,
    })
  }

  public async addLabels(labels: string[]) {
    await this.octokit.rest.issues.addLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: ensureIssueNumber(this.issueNumber),
      labels,
    })
  }

  public async closeIssue(reason: TCloseReason) {
    await this.octokit.rest.issues.update({
      owner: this.owner,
      repo: this.repo,
      issue_number: ensureIssueNumber(this.issueNumber),
      state: 'closed',
      state_reason: reason,
    })
  }

  public async createComment(body: string): Promise<number> {
    const { data } = await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: ensureIssueNumber(this.issueNumber),
      body,
    })
    return data.id
  }

  public async createCommentEmoji(commentId: number, emoji: TEmoji[]) {
    for (const content of emoji) {
      if (content && EEmoji[content]) {
        await this.octokit.rest.reactions.createForIssueComment({
          owner: this.owner,
          repo: this.repo,
          comment_id: commentId,
          content,
        })
      }
    }
  }

  public async createIssue(
    title: string,
    body: string,
    labels?: string[],
    assignees?: string[],
  ): Promise<number> {
    const { data } = await this.octokit.rest.issues.create({
      owner: this.owner,
      repo: this.repo,
      title,
      body,
      labels,
      assignees,
    })
    return data.number
  }

  public async createIssueEmoji(emoji: TEmoji[]) {
    for (const content of emoji) {
      if (content && EEmoji[content]) {
        await this.octokit.rest.reactions.createForIssue({
          owner: this.owner,
          repo: this.repo,
          issue_number: ensureIssueNumber(this.issueNumber),
          content,
        })
      }
    }
  }

  public async createLabel(
    labelName: string,
    labelColor: string = 'ededed',
    labelDescription: string = '',
  ) {
    await this.octokit.rest.issues.createLabel({
      owner: this.owner,
      repo: this.repo,
      name: labelName,
      color: labelColor,
      description: labelDescription,
    })
  }

  public async deleteComment(commentId: number) {
    await this.octokit.rest.issues.deleteComment({
      owner: this.owner,
      repo: this.repo,
      comment_id: commentId,
    })
  }

  public async getIssue() {
    const issue = await this.octokit.rest.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: ensureIssueNumber(this.issueNumber),
    })
    return issue.data as unknown as TIssueInfo
  }

  public async getUserPermission(username: string) {
    const { data } = await this.octokit.rest.repos.getCollaboratorPermissionLevel({
      owner: this.owner,
      repo: this.repo,
      username,
    })
    return data.permission as TUserPermission
  }

  public async listComments(page = 1) {
    const { data } = await this.octokit.rest.issues.listComments({
      owner: this.owner,
      repo: this.repo,
      issue_number: ensureIssueNumber(this.issueNumber),
      per_page: 100,
      page,
    })
    let comments = [...data] as unknown as TCommentList
    if (comments.length >= 100) {
      comments = comments.concat(await this.listComments(page + 1))
    }
    return comments
  }

  public async listIssues(params: IListIssuesParams, page = 1) {
    const { data } = await this.octokit.rest.issues.listForRepo({
      ...params,
      owner: this.owner,
      repo: this.repo,
      per_page: 100,
      page,
    })
    let issues = [...data] as unknown as TIssueList
    if (issues.length >= 100) {
      issues = issues.concat(await this.listIssues(params, page + 1))
    }
    return issues
  }

  public async lockIssue(lockReason: TLockReasons) {
    const params = {
      owner: this.owner,
      repo: this.repo,
      issue_number: ensureIssueNumber(this.issueNumber),
    }

    if (lockReason) {
      await this.octokit.rest.issues.lock({
        ...params,
        lock_reason: lockReason,
      })
      return
    }

    await this.octokit.rest.issues.lock(params)
  }

  public async openIssue() {
    await this.octokit.rest.issues.update({
      owner: this.owner,
      repo: this.repo,
      issue_number: ensureIssueNumber(this.issueNumber),
      state: 'open',
    })
  }

  public async removeAssignees(assignees: string[]) {
    await this.octokit.rest.issues.removeAssignees({
      owner: this.owner,
      repo: this.repo,
      issue_number: ensureIssueNumber(this.issueNumber),
      assignees,
    })
  }

  public async removeLabels(labels: string[]) {
    const issue = await this.getIssue()
    const baseLabels = issue.labels.map(({ name }) => name)
    const removeLabels = baseLabels.filter(name => labels.includes(name))

    for (const label of removeLabels) {
      await this.octokit.rest.issues.removeLabel({
        owner: this.owner,
        repo: this.repo,
        issue_number: ensureIssueNumber(this.issueNumber),
        name: label,
      })
    }
  }

  public async setLabels(labels: string[]) {
    const issue = await this.getIssue()
    const baseLabels = issue.labels.map(({ name }) => name)
    const removeLabels = baseLabels.filter(name => !labels.includes(name))
    const addLabels = labels.filter(name => !baseLabels.includes(name))

    if (removeLabels.length) {
      await this.removeLabels(removeLabels)
    }

    if (addLabels.length) {
      await this.addLabels(addLabels)
    }
  }

  public async unlockIssue() {
    await this.octokit.rest.issues.unlock({
      owner: this.owner,
      repo: this.repo,
      issue_number: ensureIssueNumber(this.issueNumber),
    })
  }

  public async updateComment(commentId: number, body: string, mode: TUpdateMode) {
    const comment = await this.octokit.rest.issues.getComment({
      owner: this.owner,
      repo: this.repo,
      comment_id: commentId,
    })
    const baseBody = comment.data.body ?? ''
    const newBody = body ? (mode === 'append' ? `${baseBody}\n${body}` : body) : baseBody

    await this.octokit.rest.issues.updateComment({
      owner: this.owner,
      repo: this.repo,
      comment_id: commentId,
      body: newBody || '',
    })
  }

  public async updateIssue(
    state: TIssueState,
    title: string | void,
    body: string | void,
    mode: TUpdateMode,
    labels?: string[] | void,
    assignees?: string[] | void,
  ) {
    const issue = await this.getIssue()
    const {
      body: baseBody,
      title: baseTitle,
      labels: baseLabels,
      assignees: baseAssignees,
      state: baseState,
    } = issue

    const baseLabelsName = baseLabels.map(({ name }) => name)
    const baseAssigneesName = baseAssignees?.map(({ login }) => login)
    const newBody = body ? (mode === 'append' ? `${baseBody ?? ''}\n${body}` : body) : baseBody

    if (labels?.length) {
      for (const label of labels) {
        if (baseLabelsName.length && !baseLabelsName.includes(label)) {
          await this.createLabel(label)
        }
      }
    }

    await this.octokit.rest.issues.update({
      owner: this.owner,
      repo: this.repo,
      issue_number: ensureIssueNumber(this.issueNumber),
      state: state || baseState,
      title: title || baseTitle,
      body: newBody ?? '',
      labels: labels?.length ? labels : baseLabelsName,
      assignees: assignees?.length ? assignees : baseAssigneesName,
    })
  }
}
