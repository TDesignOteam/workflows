import * as core from '@actions/core'
import { getClient } from 'node-cnb'

const CNB_API_URL = 'https://api.cnb.cool'

async function main(): Promise<void> {
  const org = core.getInput('org', { required: true })
  const repo = core.getInput('repo', { required: true })
  const branch = core.getInput('branch', { required: true })
  const token = core.getInput('token', { required: true })

  core.startGroup('cnb-delete-branch')
  core.info(`Org: ${org}`)
  core.info(`Repo: ${repo}`)
  core.info(`Branch: ${branch}`)
  core.endGroup()

  const client = getClient(CNB_API_URL, token)
  // 步骤 1: 查询所有 open PRs
  const prs = await client.Pulls.ListPulls({ repo, state: 'open' })
  // 步骤 2: 过滤并关闭与该分支关联的 PRs（CNB 不允许直接删除有 open PR 的分支）
  const branchPRs = prs.filter(pr => pr.head.ref === branch)
  core.info(`找到 ${branchPRs.length} 个与分支 "${branch}" 关联的 open PR`)
  for (const pr of branchPRs) {
    core.info(`关闭 PR #${pr.number} (head.ref: ${pr.head.ref})`)
    await client.Pulls.PatchPull({ repo, number: pr.number, update_pull_request_form: {
      state: 'closed',
      title: pr.title,
      body: pr.body,
    } })
  }

  // 步骤 3: 删除分支
  core.info(`删除分支 "${branch}"...`)
  await client.repo.git.branches.delete({
    repo,
    branch,
  })

  core.info('分支删除完成')
}

main()
