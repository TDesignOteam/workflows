import * as core from '@actions/core'
import * as github from '@actions/github'

export interface GithubContext {
  owner: string
  repo: string
  token: string
  dryRun: boolean
}

export class GithubHelper {
  private octokit: ReturnType<typeof github.getOctokit>
  private context: GithubContext

  constructor(context: GithubContext) {
    this.context = context
    this.octokit = github.getOctokit(context.token)
  }

  private async dryRunLog(methodName: string, params: Record<string, unknown>) {
    if (!this.context.dryRun)
      return false

    core.startGroup(`dry-run模式, 不运行${methodName}`)
    for (const [key, value] of Object.entries(params)) {
      core.info(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    }
    core.endGroup()
    return true
  }

  private get defaultRepoParams() {
    return {
      owner: this.context.owner,
      repo: this.context.repo,
    }
  }

  async getPrData(prNumber: number) {
    try {
      const { data } = await this.octokit.rest.pulls.get({
        ...this.defaultRepoParams,
        pull_number: prNumber,
      })
      return data
    }
    catch (error) {
      core.error(`获取PR数据失败: ${error}`)
      throw error
    }
  }

  async getIssueData(issueNumber: number) {
    try {
      const { data } = await this.octokit.rest.issues.get({
        ...this.defaultRepoParams,
        issue_number: issueNumber,
      })
      return data
    }
    catch (error) {
      core.error(`获取Issue数据失败: ${error}`)
      throw error
    }
  }

  async getIssueList(params?: Omit<Parameters<typeof this.octokit.rest.issues.listForRepo>[0], 'owner' | 'repo'>) {
    try {
      const { data } = await this.octokit.rest.issues.listForRepo({
        ...params,
        ...this.defaultRepoParams,
      })
      return data.filter(item => !item?.pull_request)
    }
    catch (error) {
      core.error(`获取Issue列表失败: ${error}`)
      throw error
    }
  }

  async closeIssue(issueNumber: number) {
    if (await this.dryRunLog('closeIssue', { issueNumber }))
      return

    try {
      await this.octokit.rest.issues.update({
        ...this.defaultRepoParams,
        issue_number: issueNumber,
        state: 'closed',
      })
    }
    catch (error) {
      core.error(`关闭Issue失败: ${error}`)
      throw error
    }
  }

  async createPR(title: string, head: string, body: string, base = 'develop') {
    if (await this.dryRunLog('createPR', { title, head, base, body }))
      return

    try {
      const { data } = await this.octokit.rest.pulls.create({
        ...this.defaultRepoParams,
        title,
        head,
        base,
        body,
      })
      return data
    }
    catch (error) {
      core.error(`创建PR失败: ${error}`)
      throw error
    }
  }

  async addComment(issueNumber: number, body: string) {
    if (await this.dryRunLog('addComment', { issueNumber, body }))
      return

    try {
      const { data } = await this.octokit.rest.issues.createComment({
        ...this.defaultRepoParams,
        issue_number: issueNumber,
        body,
      })
      return data
    }
    catch (error) {
      core.error(`添加评论失败: ${error}`)
      throw error
    }
  }

  async addLabels(issueNumber: number, labels: string[]) {
    if (await this.dryRunLog('addLabels', { issueNumber, labels: labels.join(', ') }))
      return

    try {
      const { data } = await this.octokit.rest.issues.addLabels({
        ...this.defaultRepoParams,
        issue_number: issueNumber,
        labels,
      })
      return data
    }
    catch (error) {
      core.error(`添加标签失败: ${error}`)
      throw error
    }
  }
}
