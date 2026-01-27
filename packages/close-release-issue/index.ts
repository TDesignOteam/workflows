import * as core from '@actions/core';
import * as github from '@actions/github';
async function main(): Promise<void> {
  const repo = core.getInput('repo')||github.context.repo.repo;
  const owner = core.getInput('owner')||github.context.repo.owner;
  core.startGroup('close-release-issue');
  core.info('close-release-issue');
  core.info(`repo: ${repo}`);
  core.info(`owner: ${owner}`);

  core.endGroup();
  
}
main();