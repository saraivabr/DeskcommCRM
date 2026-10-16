import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "stable-release-"));
  dirs.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "supabase/migrations"), { recursive: true });
  const manifest = JSON.parse(readFileSync("scripts/upstream-release.json", "utf8")) as {
    release: string; migrations: { file: string; sha256: string }[];
  };
  for (const name of ["build-upstream-release.py", "upstream-release-preflight.sql", "upstream-release-postflight.sql"])
    copyFileSync(`scripts/${name}`, join(root, "scripts", name));
  for (const entry of manifest.migrations)
    copyFileSync(`supabase/migrations/${entry.file}`, join(root, "supabase/migrations", entry.file));
  const run = () => {
    writeFileSync(join(root, "scripts/upstream-release.json"), JSON.stringify(manifest));
    return spawnSync("python3", [join(root, "scripts/build-upstream-release.py"), root, join(root, "out")], { encoding: "utf8" });
  };
  return { root, manifest, run };
}

describe("pacote explícito da atualização estável", () => {
  it("ignora arquivos fora do manifesto e gera a mesma transação verificável", () => {
    const { root, run } = fixture();
    writeFileSync(join(root, "supabase/migrations/unknown.sql"), "drop table public.contacts;");
    expect(run().status).toBe(0);
    const first = readFileSync(join(root, "out/release-apply.sql"), "utf8");
    expect(first).not.toContain("drop table public.contacts");
    expect(first).toContain("\\if :install_release");
    expect(first).toContain("Recorded release checksum differs");
    expect(first.indexOf("insert into escreveai_ops.schema_releases")).toBeGreaterThan(first.indexOf("-- source:"));
    expect(run().status).toBe(0);
    expect(readFileSync(join(root, "out/release-apply.sql"), "utf8")).toBe(first);
  });

  it.each(["checksum", "path", "duplicate", "order", "empty", "transaction"])("recusa %s antes de produzir SQL executável", (fault) => {
    const { root, manifest, run } = fixture();
    const entry = manifest.migrations[0];
    if (!entry) throw new Error("O manifesto da fixture precisa conter uma migration para testar recusas");
    if (fault === "checksum") entry.sha256 = "0".repeat(64);
    if (fault === "path") entry.file = "../../baseline.sql";
    if (fault === "duplicate") manifest.migrations.push(entry);
    if (fault === "order") manifest.migrations.reverse();
    if (fault === "empty") manifest.migrations = [];
    if (fault === "transaction") {
      const content = "COMMIT;\nselect 'must not escape outer transaction';\n";
      writeFileSync(join(root, "supabase/migrations", entry.file), content);
      entry.sha256 = createHash("sha256").update(content).digest("hex");
    }
    const result = run();
    expect(result.status).not.toBe(0);
    expect(existsSync(join(root, "out/release-apply.sql"))).toBe(false);
  });
});
