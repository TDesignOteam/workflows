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
  private dryRun: boolean

  constructor(context: GithubContext) {
    this.context = context
    this.dryRun = context.dryRun
    this.octokit = github.getOctokit(context.token)
  }

  async getPrData(pr_number: number) {
    const { data } = await this.octokit.rest.pulls.get({
      owner: this.context.owner,
      repo: this.context.repo,
      pull_number: pr_number,
    })
    return data
  }

  async getIssueData(issue_number: number) {
    const { data } = await this.octokit.rest.issues.get({
      owner: this.context.owner,
      repo: this.context.repo,
      issue_number,
    })
    return data
  }


  async getIssueList(filter?: object) {
    const { data } = await this.octokit.rest.issues.list({
      owner: this.context.owner,
      repo: this.context.repo,
      ...filter
    })
    return data
  }

  async createPR(title: string, head: string, body: string, base?: string) {
    if (this.dryRun) {
      core.startGroup('dry-run模式, 不运行createPR')
      core.info(`title: ${title}`)
      core.info(`head: ${head}`)
      core.info(`base: ${base}`)
      core.info(`body: ${body}`)
      core.endGroup()
      return
    }
    const { data } = await this.octokit.rest.pulls.create({
      owner: this.context.owner,
      repo: this.context.repo,
      title,
      head,
      base: base || 'develop',
      body,
    })
    return data
  }

  async addComment(pr_number: number, body: string) {
    if (this.dryRun) {
      core.startGroup('dry-run模式, 不运行addComment')
      core.info(`pr_number: ${pr_number}`)
      core.info(`body: ${body}`)
      core.endGroup()
      return
    }
    const { data } = await this.octokit.rest.issues.createComment({
      owner: this.context.owner,
      repo: this.context.repo,
      issue_number: pr_number,
      body,
    })
    return data
  }

  async addLabels(pr_number: number, labels: string[]) {
    if (this.dryRun) {
      core.startGroup('dry-run模式, 不运行addLabels')
      core.info(`pr_number: ${pr_number}`)
      core.info(`labels: ${labels.join(', ')}`)
      core.endGroup()
      return
    }
    const { data } = await this.octokit.rest.issues.addLabels({
      owner: this.context.owner,
      repo: this.context.repo,
      issue_number: pr_number,
      labels,
    })
    return data
  }
}
