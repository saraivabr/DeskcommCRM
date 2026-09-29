import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { credenciaisSupabaseDeTeste, destinoEhLocal } from "../../scripts/lib/env-de-teste";

const credentials = credenciaisSupabaseDeTeste();
if (!destinoEhLocal(credentials.url) || !destinoEhLocal(credentials.dbUrl))
  throw new Error("MCP copilot QA requires an isolated local database.");
const db = createClient(credentials.url, credentials.serviceRole, {
  auth: { persistSession: false },
});
const organizationId = randomUUID();
const foreignOrganizationId = randomUUID();
const email = `mcp-copilot-${randomUUID()}@example.test`;
const password = randomBytes(24).toString("base64url");
const pipelineId = randomUUID();
const foreignPipelineId = randomUUID();
const entranceId = randomUUID();
const qualifiedId = randomUUID();
const contactId = randomUUID();
const conversationId = randomUUID();
const foreignConversationId = randomUUID();
let userId = "";
let token = "";
let connectionId = "";
let cookies: Awaited<ReturnType<BrowserContext["cookies"]>> = [];

type Wire = {
  error?: unknown;
  result?: {
    isError?: boolean;
    tools?: Array<{ name: string }>;
    structuredContent?: Record<string, unknown>;
    content?: Array<{ text: string }>;
  };
};

async function rpc(context: BrowserContext, method: string, params: object = {}): Promise<Wire> {
  const response = await context.request.post("/api/mcp", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
    },
    data: { jsonrpc: "2.0", id: randomUUID(), method, params },
  });
  expect(response.ok()).toBeTruthy();
  const raw = await response.text();
  const data = raw.startsWith("event:")
    ? raw
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6)
    : raw;
  if (!data) throw new Error("MCP response did not contain a JSON payload.");
  return JSON.parse(data) as Wire;
}

function result(wire: Wire): Record<string, unknown> {
  expect(wire.error).toBeUndefined();
  expect(wire.result?.isError).not.toBe(true);
  const content =
    wire.result?.structuredContent ?? JSON.parse(wire.result?.content?.[0]?.text ?? "null");
  expect(content).not.toBeNull();
  return content as Record<string, unknown>;
}

const call = (context: BrowserContext, name: string, args: object) =>
  rpc(context, "tools/call", { name, arguments: args });

async function insert(table: string, rows: object | object[]) {
  const { error } = await db.from(table).insert(rows);
  if (error) throw error;
}

class ConnectionReview {
  constructor(readonly page: Page) {}

  async open() {
    await this.page.goto("/app/settings/ai-connections");
    await expect(
      this.page.getByRole("heading", { name: "Conectar minha IA", exact: true }),
    ).toBeVisible();
  }

  async approve(pending: Record<string, unknown>, details: string[]) {
    expect(pending.status).toBe("confirmation_required");
    await this.page.goto(String(pending.url));
    const review = this.page.getByRole("region", { name: "Confirmar operações" });
    await expect(review).toBeVisible();
    for (const detail of details) await expect(review).toContainText(detail);
    await review.getByRole("button", { name: "Aprovar operação", exact: true }).click();
    await expect(review).toContainText("Aprovada. Sua IA pode repetir a operação.");
  }
}

test.describe("personal MCP copilot, CRM and agenda", () => {
  test.describe.configure({ mode: "serial", timeout: 120_000 });

  test.beforeAll(async ({ browser, baseURL }) => {
    if (!baseURL || !destinoEhLocal(baseURL)) throw new Error("Local app required.");
    const user = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (user.error) throw user.error;
    userId = user.data.user.id;
    await insert(
      "organizations",
      [organizationId, foreignOrganizationId].map((id) => ({
        id,
        slug: `mcp-copilot-${id}`,
        legal_name: "MCP Copilot QA",
        display_name: "MCP Copilot QA",
        onboarded_at: new Date().toISOString(),
      })),
    );
    await insert("user_organizations", {
      user_id: userId,
      organization_id: organizationId,
      role: "manager",
      accepted_at: new Date().toISOString(),
    });
    await insert("crm_pipelines", [
      { id: pipelineId, organization_id: organizationId, name: "Vendas QA", slug: "vendas-qa" },
      {
        id: foreignPipelineId,
        organization_id: foreignOrganizationId,
        name: "Funil privado",
        slug: "privado",
      },
    ]);
    await insert("crm_stages", [
      {
        id: entranceId,
        organization_id: organizationId,
        pipeline_id: pipelineId,
        name: "Entrada QA",
        slug: "entrada-qa",
        position: 1000,
      },
      {
        id: qualifiedId,
        organization_id: organizationId,
        pipeline_id: pipelineId,
        name: "Qualificado QA",
        slug: "qualificado-qa",
        position: 2000,
      },
    ]);
    const channelId = randomUUID();
    const foreignChannelId = randomUUID();
    const foreignContactId = randomUUID();
    await insert("channel_sessions", [
      {
        id: channelId,
        organization_id: organizationId,
        waha_session_name: `mcp-qa-${channelId}`,
        webhook_secret_encrypted: "\\x00",
        status: "WORKING",
      },
      {
        id: foreignChannelId,
        organization_id: foreignOrganizationId,
        waha_session_name: `mcp-qa-${foreignChannelId}`,
        webhook_secret_encrypted: "\\x00",
        status: "WORKING",
      },
    ]);
    await insert("contacts", [
      { id: contactId, organization_id: organizationId, display_name: "Cliente QA" },
      {
        id: foreignContactId,
        organization_id: foreignOrganizationId,
        display_name: "Cliente privado QA",
      },
    ]);
    await insert("conversations", [
      {
        id: conversationId,
        organization_id: organizationId,
        channel_session_id: channelId,
        contact_id: contactId,
        status: "open",
        assigned_to_user_id: userId,
      },
      {
        id: foreignConversationId,
        organization_id: foreignOrganizationId,
        channel_session_id: foreignChannelId,
        contact_id: foreignContactId,
        status: "open",
      },
    ]);
    await insert("messages", {
      organization_id: organizationId,
      conversation_id: conversationId,
      channel_session_id: channelId,
      contact_id: contactId,
      type: "text",
      direction: "inbound",
      body: "Quero saber os horários para um diagnóstico.",
      external_id: `qa-${randomUUID()}`,
    });
    await insert("calendar_event_types", {
      organization_id: organizationId,
      name: "Diagnóstico QA",
      slug: "diagnostico-qa",
      duration_minutes: 30,
      minimum_notice_minutes: 60,
      booking_window_days: 60,
      is_active: true,
      default_owner_user_id: userId,
    });
    const availability = await db.from("attendant_availability").upsert(
      {
        organization_id: organizationId,
        user_id: userId,
        is_available: true,
        schedule: {
          timezone: "America/Sao_Paulo",
          windows: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, start: "09:00", end: "18:00" })),
        },
      },
      { onConflict: "organization_id,user_id" },
    );
    if (availability.error) throw availability.error;
    const login = await browser.newContext({ baseURL });
    try {
      const page = await login.newPage();
      await page.goto("/login");
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Senha", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Entrar", exact: true }).click();
      await page.waitForURL(/\/app(?:\/|$)/);
      cookies = await login.cookies();
    } finally {
      await login.close();
    }
  });

  test.beforeEach(async ({ context }) => {
    await context.addCookies(cookies);
  });

  test.afterAll(async () => {
    for (const id of [organizationId, foreignOrganizationId]) {
      const removed = await db.from("organizations").delete().eq("id", id);
      if (removed.error) throw removed.error;
    }
    if (userId) {
      const removed = await db.auth.admin.deleteUser(userId);
      if (removed.error) throw removed.error;
    }
  });

  test("manager grants concrete scopes in the browser and the server persists them", async ({
    page,
  }, testInfo) => {
    const screen = new ConnectionReview(page);
    await screen.open();
    await page.getByLabel("Nome da conexão").fill("Copilot QA");
    await page.getByLabel("Consultar páginas e pesquisar conhecimento").uncheck();
    for (const label of [
      "Consultar conversas e histórico do WhatsApp",
      "Enviar mensagens; gerar rascunhos com créditos após confirmação",
      "Consultar contatos, leads e funis do CRM",
      "Criar e atualizar leads e etapas após minha confirmação",
      "Consultar agenda, tipos de evento e horários disponíveis",
      "Agendar, remarcar e registrar resultados após minha confirmação",
      "Consultar agentes, retornos e leads em risco",
      "Programar e cancelar retornos após minha confirmação",
    ])
      await page.getByLabel(label, { exact: true }).check();
    await expect(page.getByLabel("Criar rascunhos de configuração dos agentes")).toHaveCount(0);
    await page
      .getByRole("heading", { name: "Conectar minha IA", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("connection-requested-scopes.png"),
      fullPage: true,
    });
    await testInfo.attach("Selected permissions", {
      path: testInfo.outputPath("connection-requested-scopes.png"),
      contentType: "image/png",
    });
    await page.getByRole("button", { name: "Gerar token", exact: true }).click();
    await expect(page.getByLabel("Token de conexão")).toHaveValue(/^dsk_/);
    token = await page.getByLabel("Token de conexão").inputValue();
    const saved = await db
      .from("api_tokens")
      .select("id,scopes")
      .eq("organization_id", organizationId)
      .eq("name", "Copilot QA")
      .single();
    if (saved.error) throw saved.error;
    connectionId = saved.data.id;
    expect([...saved.data.scopes].sort()).toEqual(
      [
        "agenda:read",
        "agenda:write",
        "automations:execute",
        "automations:read",
        "connection:v1",
        "crm:read",
        "crm:write",
        "role:manager",
        "whatsapp:execute",
        "whatsapp:read",
      ].sort(),
    );
    // Reload clears the one-time secret before collecting a reviewable artifact.
    await page.reload();
    await expect(page.getByText("Copilot QA", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Token de conexão")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("connection-consent.png"), fullPage: true });
    await testInfo.attach("Connection consent", {
      path: testInfo.outputPath("connection-consent.png"),
      contentType: "image/png",
    });
  });

  test("discovers stages and agenda from the bound tenant and exposes only granted tools", async ({
    context,
  }) => {
    const tools = (await rpc(context, "tools/list")).result?.tools?.map((t) => t.name) ?? [];
    expect(tools).toEqual(
      expect.arrayContaining([
        "crm_create_lead",
        "crm_update_lead",
        "crm_move_lead_stage",
        "crm_list_stages",
        "crm_get_attendance_context",
        "crm_generate_reply_draft",
        "crm_list_event_types",
        "crm_find_free_slots",
        "crm_book_appointment",
        "crm_list_followups",
        "crm_schedule_followup",
        "crm_cancel_followup",
      ]),
    );
    expect(tools).not.toContain("ai_create_agent_draft");
    expect(tools).not.toContain("content_generate_studio_post");
    const stages = result(await call(context, "crm_list_stages", { pipeline_id: pipelineId }));
    expect(JSON.stringify(stages)).toContain("Entrada QA");
    expect(JSON.stringify(stages)).toContain("Qualificado QA");
    expect(
      (await call(context, "crm_list_stages", { pipeline_id: foreignPipelineId })).result?.isError,
    ).toBe(true);
    const types = result(await call(context, "crm_list_event_types", {}));
    expect(types.tipos).toEqual(
      expect.arrayContaining([expect.objectContaining({ slug: "diagnostico-qa" })]),
    );
    const slots = result(
      await call(context, "crm_find_free_slots", {
        event_type_slug: "diagnostico-qa",
        dias_a_frente: 3,
        limite: 4,
      }),
    );
    expect((slots.horarios as unknown[]).length).toBeGreaterThan(0);
    expect((slots.horarios as unknown[]).length).toBeLessThanOrEqual(4);
    const followups = result(await call(context, "crm_list_followups", { contact_id: contactId }));
    expect(followups).toMatchObject({ contact_id: contactId, retornos: [] });
    const attendance = result(
      await call(context, "crm_get_attendance_context", { conversation_id: conversationId }),
    );
    expect(attendance.conversation).toMatchObject({ id: conversationId });
    expect(attendance.contact).toMatchObject({ id: contactId, name: "Cliente QA" });
    expect(attendance.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: "inbound",
          body: "Quero saber os horários para um diagnóstico.",
        }),
      ]),
    );
    expect(attendance.freshness).toMatchObject({
      context_current: true,
      reply_context_revision: expect.any(String),
    });
    expect(attendance.history_complete).toBe(false);
  });

  test("reviews create, edit and movement before applying each exact operation once", async ({
    page,
    context,
  }, testInfo) => {
    const review = new ConnectionReview(page);
    const args = {
      pipeline_id: pipelineId,
      stage_id: entranceId,
      contact_id: contactId,
      title: "Oportunidade Copilot QA",
      value_cents: 15000,
      owner_user_id: userId,
      operation_id: randomUUID(),
    };
    const pending = result(await call(context, "crm_create_lead", args));
    const before = await db
      .from("crm_leads")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("title", args.title);
    if (before.error) throw before.error;
    expect(before.count).toBe(0);
    await review.approve(pending, [args.title, "Cliente QA", "Vendas QA", "Entrada QA", "15000"]);
    await page.screenshot({ path: testInfo.outputPath("crm-create-approved.png"), fullPage: true });
    await testInfo.attach("Approved CRM operation", {
      path: testInfo.outputPath("crm-create-approved.png"),
      contentType: "image/png",
    });
    const created = result(await call(context, "crm_create_lead", args));
    const lead = created.lead as { id: string };
    expect(lead.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result(await call(context, "crm_create_lead", args))).toEqual(created);
    const rows = await db
      .from("crm_leads")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("title", args.title);
    if (rows.error) throw rows.error;
    expect(rows.data).toEqual([{ id: lead.id }]);

    const patch = {
      lead_id: lead.id,
      title: "Oportunidade revisada QA",
      value_cents: 25000,
      operation_id: randomUUID(),
    };
    await review.approve(result(await call(context, "crm_update_lead", patch)), [
      args.title,
      "25000",
      patch.title,
    ]);
    const edited = result(await call(context, "crm_update_lead", patch));
    expect(edited.lead).toMatchObject({ id: lead.id, title: patch.title, value_cents: 25000 });
    expect(result(await call(context, "crm_update_lead", patch))).toEqual(edited);
    const changedArgs = result(
      await call(context, "crm_update_lead", {
        ...patch,
        value_cents: 35000,
        operation_id: randomUUID(),
      }),
    );
    expect(changedArgs.status).toBe("confirmation_required");
    await page.goto(String(changedArgs.url));
    await page.getByRole("button", { name: "Recusar", exact: true }).click();
    const unchanged = await db.from("crm_leads").select("value_cents").eq("id", lead.id).single();
    if (unchanged.error) throw unchanged.error;
    expect(unchanged.data.value_cents).toBe(25000);

    const move = {
      lead_id: lead.id,
      to_stage_id: qualifiedId,
      reason: "Cliente solicitou diagnóstico QA",
      operation_id: randomUUID(),
    };
    await review.approve(result(await call(context, "crm_move_lead_stage", move)), [
      patch.title,
      "Qualificado QA",
      move.reason,
    ]);
    const moved = result(await call(context, "crm_move_lead_stage", move));
    expect(moved.lead).toMatchObject({ id: lead.id, stage_id: qualifiedId });
    expect(result(await call(context, "crm_move_lead_stage", move))).toEqual(moved);
    const activities = await db
      .from("crm_lead_activities")
      .select("id,type")
      .eq("organization_id", organizationId)
      .eq("lead_id", lead.id)
      .eq("type", "stage_changed");
    if (activities.error) throw activities.error;
    expect(activities.data).toHaveLength(1);
    await page.goto(`/app/leads/${lead.id}`);
    const dossier = page.getByRole("dialog");
    await expect(dossier.getByRole("heading", { name: patch.title, exact: true })).toBeVisible();
    await expect(dossier).toContainText("Qualificado QA");
    await expect(dossier.getByRole("list").first()).toBeVisible();
    for (const group of await dossier.getByRole("button", { name: /ações/ }).all()) {
      if ((await group.getAttribute("aria-expanded")) === "false") await group.click();
    }
    await expect(dossier).toContainText(move.reason);
    await page.screenshot({
      path: testInfo.outputPath("crm-result-in-product.png"),
      fullPage: true,
    });
    await testInfo.attach("CRM result in product", {
      path: testInfo.outputPath("crm-result-in-product.png"),
      contentType: "image/png",
    });
  });

  test("blocks a foreign conversation before provider usage and honors a live role downgrade", async ({
    page,
    context,
  }) => {
    const current = result(
      await call(context, "crm_get_attendance_context", { conversation_id: conversationId }),
    );
    const freshness = current.freshness as { reply_context_revision: string };
    const stale = await call(context, "crm_generate_reply_draft", {
      conversation_id: conversationId,
      expected_reply_context_revision: (BigInt(freshness.reply_context_revision) + 1n).toString(),
      operation_id: randomUUID(),
    });
    expect(stale.result?.isError).toBe(true);
    expect(
      (
        await call(context, "crm_get_attendance_context", {
          conversation_id: foreignConversationId,
        })
      ).result?.isError,
    ).toBe(true);
    const denied = await call(context, "crm_generate_reply_draft", {
      conversation_id: foreignConversationId,
      expected_reply_context_revision: "1",
      operation_id: randomUUID(),
    });
    expect(denied.result?.isError).toBe(true);
    const approvals = await db
      .from("mcp_action_approvals")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("tool_name", "crm_generate_reply_draft");
    if (approvals.error) throw approvals.error;
    expect(approvals.count).toBe(0);
    const usage = await db
      .from("llm_calls")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId);
    if (usage.error) throw usage.error;
    expect(usage.count).toBe(0);
    const outbound = await db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("direction", "outbound");
    if (outbound.error) throw outbound.error;
    expect(outbound.count).toBe(0);
    const downgrade = await db
      .from("user_organizations")
      .update({ role: "agent" })
      .eq("organization_id", organizationId)
      .eq("user_id", userId);
    if (downgrade.error) throw downgrade.error;
    const listed = (await rpc(context, "tools/list")).result?.tools?.map((t) => t.name) ?? [];
    expect(listed).not.toContain("crm_create_lead");
    expect(listed).not.toContain("crm_update_lead");
    expect(listed).not.toContain("crm_book_appointment");
    await page.goto("/app/settings/ai-connections");
    await expect(
      page.getByLabel("Criar e atualizar leads e etapas após minha confirmação"),
    ).toHaveCount(0);
    const scopes = await db.from("api_tokens").select("scopes").eq("id", connectionId).single();
    if (scopes.error) throw scopes.error;
    // Old grant stays stored; its manager role cannot override membership today.
    expect(scopes.data.scopes).toContain("crm:write");
    const revokeMembership = await db
      .from("user_organizations")
      .update({ revoked_at: new Date().toISOString() })
      .eq("organization_id", organizationId)
      .eq("user_id", userId);
    if (revokeMembership.error) throw revokeMembership.error;
    const noMembership = await context.request.post("/api/mcp", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream" },
      data: { jsonrpc: "2.0", id: randomUUID(), method: "tools/list", params: {} },
    });
    expect(noMembership.status()).toBe(401);
  });
});
