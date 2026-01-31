import * as core from '@actions/core';
import * as github from '@actions/github';
import { GithubHelper } from '@workflows/utils';

async function main(): Promise<void> {
  const repo = core.getInput('repo')|| github.context.repo.repo;
  const owner = core.getInput('owner')|| github.context.repo.owner;
  const token = core.getInput('token') || '';
  const dryRun = core.getBooleanInput('dry-run') || false;
  const label = core.getInput('label');
  const version = core.getInput('version');

  core.startGroup('close-release-issue');
  core.info('close-release-issue');
  core.info(`repo: ${repo}`);
  core.info(`owner: ${owner}`);
  core.endGroup();

  const githubHelper = new GithubHelper({
    owner,
    repo,
    token,
    dryRun,
  });
  const issues = await githubHelper.getIssueList({
    state: 'open',
    label
  });
  core.debug(`issues: ${JSON.stringify(issues, null, 2)}`);

  const releaseUrl = `https://github.com/${owner}/${repo}/releases/tag/${version}`
  const comment = `此问题 [${version}](${releaseUrl}) 版本已处理发布,请升级版本使用，如有问题请重新新建 issue 进行反馈，谢谢。`;
  for (const issue of issues) {
    await githubHelper.closeIssue(issue.number);
    await githubHelper.addComment(issue.number, comment);

  }
}

main();