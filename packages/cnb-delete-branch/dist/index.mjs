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
	const prs = await client.Pulls.ListPulls({
		repo,
		state: "open"
	});
	core.info(`Found ${prs.length} open PR(s) associated with branch "${branch}"`);
	for (const pr of prs) {
		core.info(`Closing PR #${pr.number} (head.ref: ${pr.head.ref})`);
		if (pr.head.ref === branch) await client.Pulls.PatchPull({
			repo,
			number: pr.number,
			update_pull_request_form: {
				state: "closed",
				title: pr.title,
				body: pr.body
			}
		});
	}
	core.info(`Deleting branch "${branch}"...`);
	await client.repo.git.branches.delete({
		repo,
		branch
	});
	core.info("Branch deletion completed successfully");
}
main();
//#endregion
export {};
