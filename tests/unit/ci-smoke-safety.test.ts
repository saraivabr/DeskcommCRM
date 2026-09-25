// @vitest-environment node
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const directories: string[] = [];
function checkout() {
  const directory = mkdtempSync(join(tmpdir(), "ci-smoke-guard-"));
  directories.push(directory);
  mkdirSync(join(directory, "scripts"));
  copyFileSync("scripts/ci-smoke.sh", join(directory, "scripts/ci-smoke.sh"));
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
it("recusa execução fora do CI antes de criar arquivos ou iniciar dependências", () => {
  const directory = checkout();
  expect(() =>
    execFileSync("bash", ["scripts/ci-smoke.sh"], {
      cwd: directory,
      env: { ...process.env, CI: "false" },
      stdio: "pipe",
    }),
  ).toThrow(/somente CI=true/);
  expect(existsSync(join(directory, ".env.e2e"))).toBe(false);
});
it.each([".env", ".env.local", ".env.production", ".env.production.local", ".env.e2e"])(
  "preserva e recusa %s preexistente",
  (file) => {
    const directory = checkout();
    writeFileSync(join(directory, file), "NAO_ALTERAR=fixture\n");
    expect(() =>
      execFileSync("bash", ["scripts/ci-smoke.sh"], {
        cwd: directory,
        env: { ...process.env, CI: "true" },
        stdio: "pipe",
      }),
    ).toThrow(/ambiente limpo/);
    expect(readFileSync(join(directory, file), "utf8")).toBe("NAO_ALTERAR=fixture\n");
  },
);
