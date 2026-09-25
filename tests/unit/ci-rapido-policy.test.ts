// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const workflow = (name: string) => readFileSync(`.github/workflows/${name}.yml`, "utf8");
const triggers = (name: string) =>
  workflow(name)
    .split(/^on:\s*$/m)[1]!
    .split(/^\S/m)[0]!;

it.each(["ci", "e2e", "perf"])("%s completo só executa sob demanda", (name) => {
  expect(triggers(name)).toContain("workflow_dispatch:");
  expect(triggers(name)).not.toMatch(/^  (pull_request|push|schedule):/m);
});
it("PR e main recebem checagens rápidas obrigatórias", () => {
  expect(triggers("ci-rapido")).toMatch(/^  pull_request:/m);
  expect(triggers("ci-rapido")).toMatch(/^  push:/m);
  const gate = workflow("ci-rapido").split("  ci-rapido:\n")[1]!;
  expect(gate).toContain("if: always()");
  expect(gate).toContain("needs: [verify, database, smoke]");
  for (const job of ["VERIFY", "DATABASE", "SMOKE"]) {
    expect(gate).toContain(`test "$${job}" = success`);
  }
});
it("imagens genéricas preservam entrega em main/tags sem repetir build em PR", () => {
  expect(triggers("publish-image")).toContain('branches: ["main"]');
  expect(triggers("publish-image")).toContain('tags: ["v*"]');
  expect(triggers("publish-image")).not.toMatch(/^  pull_request:/m);
});
