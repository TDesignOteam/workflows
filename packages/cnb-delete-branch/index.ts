import * as core from '@actions/core'
import { getClient } from 'node-cnb'

const CNB_API_URL = 'https://api.cnb.cool'

async function main(): Promise<void> {
  const repo = core.getInput('repo', { required: true })
  const branch = core.getInput('branch', { required: true })
  const token = core.getInput('token', { required: true })

  core.startGroup('cnb-delete-branch')
  core.info(`Repo: ${repo}`)
  core.info(`Branch: ${branch}`)
  core.endGroup()

  try {
    const client = getClient(CNB_API_URL, token)
    if (!client) {
      throw new Error('Failed to get CNB client')
    }

    // 步骤 1: 查询所有 open PRs
    core.info('查询所有 open PRs...')
    const prs = await client.Pulls.ListPulls({ repo, state: 'open' })
    core.info(`查询到 ${prs.length} 个 open PRs`)
    // 步骤 2: 过滤并关闭与该分支关联的 PRs（CNB 不允许直接删除有 open PR 的分支）
    const branchPRs = prs.filter((pr) => {
      const headRef = pr.head.ref.replace(/^refs\/heads\//, '')
      return headRef === branch && pr.head.repo.path === repo
    })
    core.info(`找到 ${branchPRs.length} 个与分支 "${branch}" 关联的 open PR`)
    for (const pr of branchPRs) {
      core.info(`关闭 PR #${pr.number} (head.ref: ${pr.head.ref})`)
      try {
        await client.Pulls.PatchPull({ repo, number: pr.number, update_pull_request_form: {
          state: 'closed',
          title: pr.title,
          body: pr.body,
        } })
      }
      catch (prError) {
        core.warning(`关闭 PR #${pr.number} 失败: ${prError instanceof Error ? prError.message : String(prError)}`)
      }
    }

    // 步骤 3: 删除分支
    core.info(`删除分支 "${branch}"...`)
    try {
      await client.repo.git.branches.delete({
        repo,
        branch,
      })
      core.info('分支删除完成')
    }
    catch (deleteError) {
      core.warning(`删除分支 "${branch}" 失败: ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`)
    }
  }
  catch (error) {
    core.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
    if (error instanceof Error && error.stack) {
      core.debug(error.stack)
    }
    core.setFailed(`cnb-delete-branch failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

main().catch((error) => {
  core.setFailed(`cnb-delete-branch failed: ${error instanceof Error ? error.message : String(error)}`)
})
