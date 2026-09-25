import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const required = ["ci-rapido.yml"];

export function productionChecks(runs, sha, branch = "main") {
  return required.map((file) => {
    const run = runs
      .filter((run) => run.head_sha === sha && run.path === `.github/workflows/${file}`)
      .filter((run) => run.event === "push" && run.head_branch === branch)
      .sort((a, b) => b.id - a.id)[0];
    return { file, state: !run || run.status !== "completed" ? "pending" : run.conclusion };
  });
}

async function main() {
  const { GITHUB_REPOSITORY: repo, GITHUB_SHA: sha, GITHUB_REF_NAME: branch } = process.env;
  if (!repo || !branch || !/^[a-f0-9]{40}$/.test(sha ?? ""))
    throw new Error("Repository and immutable revision required");
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const response = JSON.parse(
      execFileSync("gh", ["api", `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`], {
        encoding: "utf8",
        timeout: 15_000,
      }),
    );
    const checks = productionChecks(response.workflow_runs, sha, branch);
    console.info(checks.map(({ file, state }) => `${file}: ${state}`).join("; "));
    if (checks.every(({ state }) => state === "success")) return;
    if (checks.some(({ state }) => !["success", "pending"].includes(state))) {
      throw new Error("Production remains unchanged: required checks did not pass");
    }
    await new Promise((resolve) => setTimeout(resolve, 20_000));
  }
  throw new Error("Production remains unchanged: timed out waiting for required checks");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
