import { readFileSync } from "node:fs";
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
  event: "push",
  head_branch: "main",
  status: "completed",
  conclusion,
});
it("requires only the automatic fast workflow for the exact revision", () => {
  expect(check([]).every((r) => r.state === "pending")).toBe(true);
  expect(check([run("ci-rapido.yml", 1, "success", "old")])[0]?.state).toBe("pending");
  expect(check(["ci-rapido.yml"].map((f) => run(f))).every((r) => r.state === "success")).toBe(
    true,
  );
});
it("a newer failure, cancellation or skipped run cannot reuse an old green result", () => {
  for (const state of ["failure", "cancelled", "skipped"]) {
    expect(check([run("ci-rapido.yml"), run("ci-rapido.yml", 2, state)])[0]?.state).toBe(state);
  }
  expect(
    check([run("ci-rapido.yml"), { ...run("ci-rapido.yml", 2), status: "in_progress" }])[0]?.state,
  ).toBe("pending");
});

it("does not accept a PR merge preview, another branch, or manual full checks", () => {
  for (const wrong of [
    { ...run("ci-rapido.yml"), event: "pull_request" },
    { ...run("ci-rapido.yml"), event: "workflow_dispatch" },
    { ...run("ci-rapido.yml"), head_branch: "other" },
    run("ci.yml"),
    run("e2e.yml"),
    run("perf.yml"),
  ])
    expect(check([wrong])).toEqual([{ file: "ci-rapido.yml", state: "pending" }]);
});

it("keeps candidate publication separate from gated deployment and latest", () => {
  const workflow = readFileSync(".github/workflows/deploy-production.yml", "utf8");
  const candidate = workflow.slice(
    workflow.indexOf("  build-candidate:"),
    workflow.indexOf("  deploy:"),
  );
  const deploy = workflow.slice(workflow.indexOf("  deploy:"));
  expect(candidate).toContain("candidate-${{ github.sha }}");
  expect(candidate).toContain("file: ./Dockerfile.worker");
  expect(candidate).toContain("worker_digest: ${{ steps.build-worker.outputs.digest }}");
  expect(candidate).toContain("--network none");
  expect(candidate).toContain("scripts/sonda-do-laco-de-event-log.ts");
  expect(candidate).toContain("resolve-turn-agent.ts");
  expect(candidate).toContain("agente-da-prospeccao.ts");
  expect(candidate).toContain("boot falhou:.*ECONNREFUSED.*127.0.0.1:1");
  expect(candidate).toContain('"org.opencontainers.image.revision"] == $sha');
  expect(candidate).toContain('index("APP_VERSION=" + $sha)');
  expect(candidate).not.toContain(":latest");
  expect(deploy).toContain("needs: build-candidate");
  expect(deploy).toContain("${{ needs.build-candidate.outputs.digest }}");
  expect(deploy.indexOf("require-production-checks.mjs")).toBeLessThan(
    deploy.indexOf("imagetools create"),
  );
  expect(deploy).toContain('[ "$ACTUAL" = "$IMAGE_DIGEST" ]');
  expect(deploy).toContain('[ "$ACTUAL_WORKER" = "$WORKER_DIGEST" ]');
  expect(deploy).toContain('"$IMAGE_TAG $IMAGE_DIGEST $WORKER_DIGEST"');
  expect(deploy.indexOf('[ "$CURRENT" = "$GITHUB_SHA" ]')).toBeLessThan(deploy.indexOf("ssh -i"));
  expect(deploy.indexOf("Validar Saude em Producao")).toBeLessThan(deploy.indexOf("$IMAGE:latest"));
  expect(deploy.indexOf("Validar Saude em Producao")).toBeLessThan(deploy.indexOf("$WORKER_IMAGE:production-latest"));
  expect(deploy).not.toContain('--tag "$WORKER_IMAGE:latest"');
});
