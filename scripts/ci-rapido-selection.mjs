import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const CRITICAL_UNIT = [
  "tests/unit/ci-rapido-selection.test.ts",
  "tests/unit/ci-rapido-policy.test.ts",
  "tests/unit/ci-smoke-safety.test.ts",
  "tests/unit/require-role-mfa.test.ts",
  "tests/unit/cron-auth.test.ts",
  "tests/unit/billing-route-gates.test.ts",
  "tests/unit/billing-metered-operation.test.ts",
  "tests/unit/production-checks.test.ts",
];
export const CRITICAL_DB = [
  "tests/invariants/rls-completude-varredura.test.ts",
  "tests/invariants/subscription-isolation.test.ts",
  "tests/invariants/pg-como-supabase.test.ts",
  "tests/invariants/audit-log-sob-o-default-acl-do-supabase.test.ts",
];

/** Explicit limited coverage, never a claim that the manual regression ran. */
export function selectChecks(paths, { base = null, availableDb = [] } = {}) {
  const diagnostics = [];
  const globalChange = paths.some((path) =>
    /^(package\.json|pnpm-lock\.yaml|vitest[^/]*|tsconfig[^/]*|next\.config\.[^/]*)$/.test(path),
  );
  const unknown = paths.filter(
    (path) =>
      !/^(app\/|components\/|lib\/|hooks\/|workers\/|tests\/|scripts\/|supabase\/|docs\/|\.github\/|\.changes\/|hostgator-setup-kit\/)/.test(
        path,
      ),
  );
  if (!base)
    diagnostics.push(
      "Base indisponível: executando controles críticos; impacto por imports não determinado.",
    );
  if (!paths.length) diagnostics.push("Diff vazio: controles críticos continuam obrigatórios.");
  if (globalChange)
    diagnostics.push(
      "Configuração global mudou: seleção por imports seria ampla; controles críticos automáticos, regressão completa somente sob demanda.",
    );
  if (unknown.length)
    diagnostics.push(
      `Caminhos sem mapeamento: ${unknown.join(", ")}. Controles críticos executados; cobertura adicional não inferida.`,
    );
  const db = new Set(CRITICAL_DB);
  for (const path of paths) {
    if (/^tests\/invariants\/.*\.test\.ts$/.test(path) && availableDb.includes(path)) db.add(path);
  }
  if (
    paths.some((path) =>
      /^(lib\/billing\/|components\/billing\/|app\/.*billing|supabase\/)/.test(path),
    )
  ) {
    for (const path of availableDb)
      if (/\/(subscription-[^/]+|commercial-accounts)\.test\.ts$/.test(path)) db.add(path);
  }
  return {
    base,
    changedFiles: paths,
    unit: CRITICAL_UNIT,
    affected: Boolean(base && paths.length && !globalChange && !unknown.length),
    database: [...db].sort(),
    diagnostics,
    coverage: "Controles críticos + impacto selecionado; regressão completa não executada.",
  };
}

export function createPlan() {
  let base = process.env.CI_BASE_SHA ?? "";
  let paths = [];
  if (/^[a-f0-9]{40}$/.test(base) && !/^0+$/.test(base)) {
    try {
      execFileSync("git", ["cat-file", "-e", `${base}^{commit}`], { stdio: "pipe" });
      paths = execFileSync(
        "git",
        ["diff", "--name-only", "--diff-filter=ACMRD", `${base}...HEAD`],
        { encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .filter(Boolean);
    } catch {
      base = "";
    }
  } else base = "";
  const availableDb = readdirSync("tests/invariants")
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `tests/invariants/${name}`);
  const plan = selectChecks(paths, { base: base || null, availableDb });
  for (const path of [...plan.unit, ...plan.database]) {
    if (!existsSync(path)) throw new Error(`Controle obrigatório ausente: ${path}`);
  }
  return plan;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.info(JSON.stringify(createPlan(), null, 2));
}
