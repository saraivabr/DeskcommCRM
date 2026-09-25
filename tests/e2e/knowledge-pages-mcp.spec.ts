import { randomBytes, randomUUID } from "node:crypto";
import { test, expect, type BrowserContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { credenciaisSupabaseDeTeste, destinoEhLocal } from "../../scripts/lib/env-de-teste";

const credentials = credenciaisSupabaseDeTeste();
if (!destinoEhLocal(credentials.url))
  throw new Error("Knowledge QA requires an isolated local database.");
const db = createClient(credentials.url, credentials.serviceRole, {
  auth: { persistSession: false },
});
const organizationId = randomUUID();
const email = `knowledge-${randomUUID()}@example.test`;
const password = randomBytes(24).toString("base64url");
let userId: string;
let context: BrowserContext;
test.describe("knowledge pages and user-bound MCP", () => {
  test.describe.configure({ mode: "serial", timeout: 120_000 });
  test.beforeAll(async ({ browser, baseURL }) => {
    if (!baseURL || !destinoEhLocal(baseURL)) throw new Error("Local app required.");
    const { data, error } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw error;
    userId = data.user.id;
    const org = await db.from("organizations").insert({
      id: organizationId,
      slug: `knowledge-${organizationId}`,
      legal_name: "Knowledge QA",
      display_name: "Knowledge QA",
      onboarded_at: new Date().toISOString(),
    });
    if (org.error) throw org.error;
    const member = await db.from("user_organizations").insert({
      user_id: userId,
      organization_id: organizationId,
      role: "agent",
      accepted_at: new Date().toISOString(),
    });
    if (member.error) throw member.error;
    context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL(/\/app(?:\/|$)/);
    await page.close();
  });
  test.afterAll(async () => {
    await context?.close();
    const removed = await db.from("organizations").delete().eq("id", organizationId);
    if (removed.error) throw removed.error;
    if (userId) await db.auth.admin.deleteUser(userId);
  });
  test("persists editor content, preserves failed saves, and restores archived pages", async () => {
    const page = await context.newPage();
    await page.goto("/app/knowledge");
    await page.getByRole("button", { name: "+ Nova página", exact: true }).click();
    await page.getByLabel("Título da página").fill("Manual QA");
    const editor = page.locator('.bn-editor[contenteditable="true"]');
    await editor.fill("O prazo de atendimento é dois dias úteis.");
    await expect(page.getByRole("status").filter({ hasText: "Salvo" })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Título da página")).toHaveValue("Manual QA");
    await expect(page.locator(".bn-editor")).toContainText("dois dias úteis");
    let failNext = true;
    await page.route("**/api/v1/knowledge", (route) => {
      if (route.request().method() === "POST" && failNext) {
        failNext = false;
        return route.abort();
      }
      return route.continue();
    });
    await editor.fill("O prazo atualizado é três dias úteis.");
    await expect(page.getByRole("status").filter({ hasText: "Não salvo" })).toBeVisible();
    await expect(page.locator(".bn-editor")).toContainText("três dias úteis");
    await page.getByRole("button", { name: "Tentar salvar novamente" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Salvo" })).toBeVisible();
    page.on("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Mover para lixeira", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Na lixeira" })).toBeVisible();
    await page.getByRole("button", { name: "Restaurar", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Salvo" })).toBeVisible();
    await page.reload();
    await expect(page.locator(".bn-editor")).toContainText("três dias úteis");
    await page.close();
  });
  test("imports a PDF through the browser and rejects private URL targets", async () => {
    const page = await context.newPage();
    await page.goto("/app/knowledge");
    await page.locator('input[type="file"]').setInputFiles("tests/fixtures/sample-text.pdf");
    await expect(page.getByLabel("Título da página")).toHaveValue("sample-text.pdf", {
      timeout: 30_000,
    });
    await expect(page.locator(".bn-editor")).not.toBeEmpty();
    const response = await context.request.post("/api/v1/knowledge/import", {
      data: { url: "https://127.0.0.1/private" },
    });
    expect(response.status()).toBe(422);
    await page.close();
  });
  test("requires human approval for exact parameters and rejects revoked tokens", async ({
    baseURL,
  }) => {
    const origin = new URL(baseURL!).origin;
    const created = await context.request.post("/api/v1/mcp/connections", {
      headers: { Origin: origin },
      data: { name: "MCP QA", scopes: ["knowledge:read", "knowledge:write"] },
    });
    expect(created.ok()).toBeTruthy();
    const { data: connection } = await created.json();
    async function tool(
      name: string,
      args: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      const response = await context.request.post("/api/mcp", {
        headers: {
          Authorization: `Bearer ${connection.token}`,
          Accept: "application/json, text/event-stream",
        },
        data: {
          jsonrpc: "2.0",
          id: randomUUID(),
          method: "tools/call",
          params: { name, arguments: args },
        },
      });
      expect(response.ok()).toBeTruthy();
      const text = await response.text();
      const wire = JSON.parse(
        text.startsWith("event:")
          ? text
              .split("\n")
              .find((line) => line.startsWith("data: "))!
              .slice(6)
          : text,
      );
      expect(wire.error).toBeUndefined();
      expect(wire.result.isError).not.toBe(true);
      return wire.result.structuredContent ?? JSON.parse(wire.result.content[0].text);
    }
    const id = randomUUID();
    await tool("knowledge_save_page", {
      id,
      title: "Archive QA",
      markdown: "Synthetic confirmation test.",
      parent_id: null,
      expected_revision: 0,
      operation_id: randomUUID(),
    });
    const args = { id, expected_revision: 1, operation_id: randomUUID() };
    const pending = await tool("knowledge_archive_page", args);
    expect(pending.status).toBe("confirmation_required");
    expect((await tool("knowledge_read_page", { id })).archived).toBe(false);
    // Bearer alone cannot impersonate the approving browser session.
    const unauthenticated = await context.browser()!.newContext({ baseURL });
    const denied = await unauthenticated.request.post("/api/v1/mcp/approvals", {
      headers: { Origin: origin, Authorization: `Bearer ${connection.token}` },
      data: { id: pending.approval_id, approve: true },
    });
    expect(denied.status()).toBe(401);
    await unauthenticated.close();
    const page = await context.newPage();
    await page.goto(String(pending.url));
    await page.getByRole("button", { name: "Aprovar operação", exact: true }).click();
    await expect(
      page.getByText("Aprovada. Sua IA pode repetir a operação.", { exact: false }),
    ).toBeVisible();
    expect((await tool("knowledge_archive_page", args)).revision).toBe(2);
    expect((await tool("knowledge_archive_page", args)).revision).toBe(2);
    expect(
      (
        await tool("knowledge_archive_page", {
          ...args,
          expected_revision: 2,
          operation_id: randomUUID(),
        })
      ).status,
    ).toBe("confirmation_required");
    const revoked = await context.request.delete(`/api/v1/mcp/connections?id=${connection.id}`);
    expect(revoked.ok()).toBeTruthy();
    const rejected = await context.request.post("/api/mcp", {
      headers: {
        Authorization: `Bearer ${connection.token}`,
        Accept: "application/json, text/event-stream",
      },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(rejected.status()).toBe(401);
    await page.close();
  });
});
