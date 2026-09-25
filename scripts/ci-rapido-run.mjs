import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createPlan } from "./ci-rapido-selection.mjs";

const mode = process.argv[2];
if (!["unit", "database"].includes(mode)) throw new Error("Use unit ou database");
const plan = createPlan();
for (const diagnostic of plan.diagnostics) console.info(`::warning::${diagnostic}`);
console.info(JSON.stringify(plan, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### CI rápido: ${mode}\n${plan.coverage}\n\nBase: ${plan.base ?? "indisponível"}\n\n${plan.diagnostics.join("\n")}\n\nTestes obrigatórios selecionados:\n${(mode === "unit" ? plan.unit : plan.database).map((path) => `- ${path}`).join("\n")}\n`,
  );
}
function run(args) {
  const result = spawnSync("pnpm", args, { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (mode === "unit") {
  // Nonempty mandatory selection has no passWithNoTests escape hatch.
  run(["exec", "vitest", "run", "--project", "cercas"]);
  run(["exec", "vitest", "run", ...plan.unit]);
  if (plan.affected) {
    // Inspect impact before execution: a shared module must not turn the quick
    // lane into the full suite. Collection errors fail; broad impact is explicit.
    const listed = spawnSync(
      "pnpm",
      [
        "exec",
        "vitest",
        "list",
        "--project",
        "produto",
        "--changed",
        plan.base,
        "--filesOnly",
        "--json",
      ],
      { encoding: "utf8", env: process.env, timeout: 120000 },
    );
    if (listed.error || listed.status !== 0) throw listed.error ?? new Error(listed.stderr);
    const files = JSON.parse(listed.stdout);
    if (!Array.isArray(files) || files.some((row) => typeof row.file !== "string"))
      throw new Error("Seleção de testes afetados inválida");
    const message =
      files.length > 60
        ? `::warning::Impacto amplo (${files.length} arquivos de teste): controles críticos e cercas medidos; regressão completa disponível somente sob demanda.`
        : `Testes adicionais relacionados por imports: ${files.length} arquivos.`;
    console.info(message);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${message}\n`);
    if (files.length > 0 && files.length <= 60) {
      run(["exec", "vitest", "run", "--project", "produto", "--changed", plan.base]);
    }
  }
} else {
  // test-db builds and reapplies the real baseline; arguments limit only the assertions.
  run(["test:db", ...plan.database]);
  // Upgrade with populated data remains a separate, bounded safety check.
  run(["test:db:update"]);
}
