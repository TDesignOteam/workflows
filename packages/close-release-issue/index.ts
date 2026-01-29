import * as core from '@actions/core';
import * as github from '@actions/github';
import { GithubHelper } from '@workflows/utils';

async function main(): Promise<void> {
  const repo = core.getInput('repo')|| github.context.repo.repo;
  const owner = core.getInput('owner')|| github.context.repo.owner;
  const token = core.getInput('token') || '';
  const dryRun = core.getBooleanInput('dry-run') || false;

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
  });
  core.info(`issues: ${JSON.stringify(issues, null, 2)}`);
}
main();