import { info } from '@actions/core'
import { exec, getExecOutput } from '@actions/exec'
import { GIT_CONFIG } from './constants'

export interface GitContext {
  owner: string
  repo: string
  token: string
  dryRun: boolean
  repoPath?: string
}

export class GitHelper {
  private readonly token: string
  private readonly owner: string
  private readonly repo: string
  private readonly repoPath: string
  private readonly dryRun: boolean

  constructor(context: GitContext) {
    this.token = context.token
    this.owner = context.owner
    this.repo = context.repo
    this.dryRun = context.dryRun
    this.repoPath = context.repoPath ?? `./${context.repo}`
  }

  private isDryRun(): boolean {
    return this.dryRun
  }

  private logDryRunInfo(action: string, details?: Record<string, unknown>): void {
    if (this.isDryRun()) {
      const message = details ? `${action}: ${JSON.stringify(details)}` : action
      info(`[DRY-RUN] ${message}`)
    }
  }

  private async initConfig(): Promise<void> {
    await exec('git', ['config', '--global', 'user.name', GIT_CONFIG.USER_NAME])
    await exec('git', ['config', '--global', 'user.email', GIT_CONFIG.USER_EMAIL])
    if (this.token === 'test') {
      return
    }
    await exec('git', ['config', '--global', `url.https://${this.token}@github.com/.insteadOf`, 'https://github.com/'])
  }

  async getConflictFiles(): Promise<string[]> {
    const { stdout } = await getExecOutput('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: this.repoPath })
    const conflictFiles = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
    return conflictFiles
  }

  private get repoUrl(): string {
    return `https://github.com/${this.owner}/${this.repo}.git`
  }

  async clone(): Promise<string> {
    await this.initConfig()
    info(this.repoUrl)
    await exec('ls', ['-al'])
    await exec('git', ['clone', this.repoUrl, this.repoPath])
    await exec('ls', ['-al'])
    const { stdout } = await getExecOutput('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.repoPath })
    info(`当前分支: ${stdout.trim()}`)
    return stdout.trim()
  }

  async createBranch(branch: string): Promise<void> {
    await exec('git', ['checkout', '-b', branch], { cwd: this.repoPath })
  }

  async checkoutBranch(branch: string): Promise<void> {
    await exec('git', ['checkout', branch], { cwd: this.repoPath })
  }

  async checkoutPr(prNumber: number): Promise<void> {
    await exec('git', ['fetch', 'origin', `pull/${prNumber}/head:pr-${prNumber}`], { cwd: this.repoPath })
    await exec('git', ['checkout', `pr-${prNumber}`], { cwd: this.repoPath })
  }

  async addRemote(name: string, url: string): Promise<void> {
    await exec('git', ['remote', 'add', name, url], { cwd: this.repoPath })
    await exec('git', ['fetch', name], { cwd: this.repoPath })
  }

  async setUpstream(remote: string, branch: string): Promise<void> {
    await exec('git', ['branch', '--set-upstream-to', `${remote}/${branch}`], { cwd: this.repoPath })
  }

  async commit(message: string): Promise<void> {
    await exec('git', ['commit', '-am', message, '--no-verify'], { cwd: this.repoPath })
  }

  async push(branch: string, forkOwner?: string): Promise<void> {
    if (this.isDryRun()) {
      this.logDryRunInfo('git push', { branch, forkOwner })
      return
    }
    if (forkOwner) {
      await exec('git', ['push', forkOwner, `HEAD:${branch}`], { cwd: this.repoPath })
    }
    else {
      await exec('git', ['push', 'origin', branch], { cwd: this.repoPath })
    }
  }

  async initSubmodule(): Promise<void> {
    await exec('git', ['submodule', 'update', '--init', '--recursive'], { cwd: this.repoPath })
  }

  async updateSubmodule(): Promise<void> {
    await exec('git', ['submodule', 'update', '--remote'], { cwd: this.repoPath })
  }

  async isNeedCommit(): Promise<boolean> {
    const { stdout } = await getExecOutput('git', ['status', '--porcelain'], { cwd: this.repoPath })
    return stdout.trim() !== ''
  }

  async printDiff(): Promise<void> {
    await exec('git', ['diff'], { cwd: this.repoPath })
  }
}
