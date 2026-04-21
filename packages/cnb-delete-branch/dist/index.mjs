import * as core from "@actions/core";
import { getClient } from "node-cnb";
//#region index.ts
const CNB_API_URL = "https://api.cnb.cool";
async function main() {
	const org = core.getInput("org", { required: true });
	const repo = core.getInput("repo", { required: true });
	const branch = core.getInput("branch", { required: true });
	const token = core.getInput("token", { required: true });
	core.startGroup("cnb-delete-branch");
	core.info(`Org: ${org}`);
	core.info(`Repo: ${repo}`);
	core.info(`Branch: ${branch}`);
	core.endGroup();
	const client = getClient(CNB_API_URL, token);
	const branchPRs = (await client.Pulls.ListPulls({
		repo,
		state: "open"
	})).filter((pr) => pr.head.ref === branch);
	core.info(`找到 ${branchPRs.length} 个与分支 "${branch}" 关联的 open PR`);
	for (const pr of branchPRs) {
		core.info(`关闭 PR #${pr.number} (head.ref: ${pr.head.ref})`);
		await client.Pulls.PatchPull({
			repo,
			number: pr.number,
			update_pull_request_form: {
				state: "closed",
				title: pr.title,
				body: pr.body
			}
		});
	}
	core.info(`删除分支 "${branch}"...`);
	await client.repo.git.branches.delete({
		repo,
		branch
	});
	core.info("分支删除完成");
}
main();
//#endregion
export {};
