import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function select(paths: string[], base: string | null = "a".repeat(40), availableDb: string[] = []) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { selectChecks } from './scripts/ci-rapido-selection.mjs';
    console.log(JSON.stringify(selectChecks(${JSON.stringify(paths)},${JSON.stringify({ base, availableDb })})));`,
      ],
      { encoding: "utf8" },
    ),
  );
}
describe("CI rápido seleciona impacto sem fingir regressão completa", () => {
  it("mantém controles críticos com base ausente, diff vazio ou caminho desconhecido", () => {
    for (const plan of [select([], null), select([]), select(["unknown.area"])]) {
      expect(plan.unit.length).toBeGreaterThan(3);
      expect(plan.database).toContain("tests/invariants/rls-completude-varredura.test.ts");
      expect(plan.database).toContain("tests/invariants/subscription-isolation.test.ts");
      expect(plan.affected).toBe(false);
      expect(plan.diagnostics.length).toBeGreaterThan(0);
      expect(plan.coverage).toContain("completa não executada");
    }
  });
  it("mudança de produto usa impacto por imports, configurações globais têm diagnóstico explícito", () => {
    expect(select(["lib/billing/entitlements.ts"]).affected).toBe(true);
    const global = select(["package.json"]);
    expect(global.affected).toBe(false);
    expect(global.diagnostics.join(" ")).toContain("global");
  });
  it("inclui invariantes alterados existentes e dependências de cobrança", () => {
    const available = [
      "tests/invariants/commercial-accounts.test.ts",
      "tests/invariants/subscription-ai-allowance.test.ts",
      "tests/invariants/new-rule.test.ts",
    ];
    const plan = select(
      ["lib/billing/plans.ts", "tests/invariants/new-rule.test.ts"],
      "a".repeat(40),
      available,
    );
    expect(plan.database).toEqual(expect.arrayContaining(available));
    expect(select(["tests/invariants/deleted.test.ts"]).database).not.toContain(
      "tests/invariants/deleted.test.ts",
    );
  });
  it("executor sempre roda cercas e install/update reais com lista não vazia", () => {
    const runner = readFileSync("scripts/ci-rapido-run.mjs", "utf8");
    expect(runner).toContain('"--project", "cercas"');
    expect(runner).toContain('run(["test:db", ...plan.database])');
    expect(runner).toContain('run(["test:db:update"])');
    expect(runner).not.toContain("--passWithNoTests");
  });
});
