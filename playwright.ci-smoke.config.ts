import { defineConfig } from "@playwright/test";

// O script fornece o ambiente validado. Invocação direta não cai em .env.local.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const databaseUrl = process.env.SUPABASE_DB_URL;
for (const value of [supabaseUrl, databaseUrl]) {
  if (!value || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname)) {
    throw new Error("Smoke exige Supabase e Postgres locais; rode scripts/ci-smoke.sh.");
  }
}
if (!process.env.OWNER_EMAIL || !process.env.OWNER_PASSWORD) {
  throw new Error("Smoke exige o dono sintético criado por bootstrap-owner.");
}
const baseURL = "http://localhost:3001";
export default defineConfig({
  testDir: "./tests/journeys",
  testMatch: "ci-smoke.spec.ts",
  outputDir: "test-results/ci-smoke",
  globalTimeout: 90_000,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report/ci-smoke", open: "never" }]],
  use: {
    baseURL,
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm exec next start --port 3001",
    url: `${baseURL}/login`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
