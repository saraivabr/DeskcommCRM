import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

function check(runs: object[]) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { productionChecks } from './scripts/require-production-checks.mjs';
     console.log(JSON.stringify(productionChecks(${JSON.stringify(runs)}, 'revision')));`,
      ],
      { encoding: "utf8" },
    ),
  ) as { file: string; state: string }[];
}
const run = (file: string, id = 1, conclusion = "success", sha = "revision") => ({
  id,
  head_sha: sha,
  path: `.github/workflows/${file}`,
  event: "pull_request",
  status: "completed",
  conclusion,
});
it("requires all four workflows for the exact revision", () => {
  expect(check([]).every((r) => r.state === "pending")).toBe(true);
  expect(check([run("ci.yml", 1, "success", "old")])[0]?.state).toBe("pending");
  expect(
    check(["ci.yml", "e2e.yml", "perf.yml", "publish-image.yml"].map((f) => run(f))).every(
      (r) => r.state === "success",
    ),
  ).toBe(true);
});
it("a newer failure, cancellation or skipped run cannot reuse an old green result", () => {
  for (const state of ["failure", "cancelled", "skipped"]) {
    expect(check([run("ci.yml"), run("ci.yml", 2, state)])[0]?.state).toBe(state);
  }
  expect(check([run("ci.yml"), { ...run("ci.yml", 2), status: "in_progress" }])[0]?.state).toBe(
    "pending",
  );
});
