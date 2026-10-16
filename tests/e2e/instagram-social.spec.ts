import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// UI regression against authenticated local Supabase. The independent HTTP receiver
// journey is documented in user-journey-map; these fixtures never send a real DM.
test.use({ channel: process.env.PLAYWRIGHT_CHANNEL });
test("selects a post, edits a populated Direct and shows a provider failure", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url))
    throw new Error("Local Supabase required");
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const org = randomUUID(),
    email = `instagram-${org}@qa.local`,
    password = `QA!${randomUUID()}`;
  const user = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (user.error) throw user.error;
  const created = await admin.from("organizations").insert({
    id: org,
    slug: `instagram-${org}`,
    display_name: "Instagram QA",
    legal_name: "Instagram QA",
    onboarded_at: new Date().toISOString(),
  });
  if (created.error) throw created.error;
  const membership = await admin.from("user_organizations").insert({
    user_id: user.data.user.id,
    organization_id: org,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  if (membership.error) throw membership.error;
  const account = "bbbbbbbbbbbbbbbbbbbbbbbb";
  let rule: Record<string, unknown> | null = null;
  await page.route("**/api/v1/growth/instagram**", async (route) => {
    const request = route.request(),
      u = new URL(request.url());
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      if (body.action === "toggle") rule = { ...rule, isActive: body.is_active };
      else
        rule = {
          id: "cccccccccccccccccccccccc",
          accountId: account,
          platformPostId: body.rule.post_id,
          name: body.rule.name,
          keywords: body.rule.keywords,
          matchMode: body.rule.match_mode,
          dmMessage: body.rule.dm_response_template,
          commentReply: body.rule.comment_reply,
          isActive: true,
          stats: { triggered: 1, dmsSent: 0, dmsFailed: 1, read: 0 },
        };
      await route.fulfill({ json: { data: { saved: true } } });
    } else if (u.searchParams.has("account_id"))
      await route.fulfill({
        json: { data: { posts: [{ id: "123456789", message: "Cardápio do café" }] } },
      });
    else if (u.searchParams.has("logs"))
      await route.fulfill({
        json: {
          data: {
            logs: [
              {
                id: "log1",
                status: "failed",
                error: "Permissão de Direct ausente.",
                createdAt: new Date().toISOString(),
              },
            ],
          },
        },
      });
    else
      await route.fulfill({
        json: {
          data: {
            accounts: [{ id: account, username: "cafeteria_qa", active: true }],
            automations: rule ? [rule] : [],
            can_edit: true,
          },
        },
      });
  });
  try {
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));
    await page.goto("/app/instagram/growth");
    await page.getByRole("button", { name: "Nova automação", exact: true }).click();
    await page.getByLabel("Nome da automação").fill("Cardápio");
    await page.getByLabel("Postagem que receberá os comentários").selectOption("123456789");
    await page.getByLabel("Palavras-chave, separadas por vírgula").fill("QUERO");
    await page.getByLabel("Mensagem no Direct", { exact: true }).fill("Segue nosso cardápio.");
    await page.getByRole("button", { name: "Salvar e ativar", exact: true }).click();
    await page.getByRole("button", { name: "Editar", exact: true }).click();
    await page.getByLabel("Mensagem no Direct", { exact: true }).fill("Cardápio atualizado.");
    await page.getByRole("button", { name: "Salvar alterações", exact: true }).click();
    await expect(page.getByText("Cardápio atualizado.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Pausar", exact: true }).click();
    await expect(page.getByText("Pausada", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Ver resultados", exact: true }).click();
    await expect(page.getByText("Permissão de Direct ausente.")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: ".superpowers/evidence/instagram-zernio/e2e-mobile.png",
      fullPage: true,
    });
    // Read recovery and independent Meta destination; never publish or send a real message.
    await page.route("**/api/v1/instagram/account", (route) =>
      route.fulfill({
        json: {
          data: {
            account: { username: "conta_nativa", active: true, provider: "meta", avatar_url: null },
          },
        },
      }),
    );
    let stalled = true;
    await page.route("**/api/v1/instagram/insights**", async (route) => {
      if (stalled) return; // held until the client deadline aborts it
      const params = new URL(route.request().url()).searchParams;
      await route.fulfill({
        json: {
          data: params.has("account_id")
            ? {
                insights: {
                  dateRange: { since: "2026-09-16", until: "2026-10-16" },
                  metrics: { reach: { total: 42 } },
                },
              }
            : {
                connected: true,
                accounts: [
                  {
                    id: "10000000-0000-4000-8000-000000000001",
                    connection_id: "10000000-0000-4000-8000-000000000002",
                    provider: "meta",
                    name: "conta_nativa",
                    insights_available: true,
                  },
                ],
                provider_errors: { zernio: { message: "Confira a cobrança do provedor." } },
              },
        },
      });
    });
    await page.clock.install();
    await page.goto("/app/instagram/insights");
    await expect(
      page.getByRole("status").filter({ hasText: "Preparando seu espaço" }),
    ).toBeVisible();
    await page.clock.fastForward(21_000);
    await expect(page.getByText("A consulta demorou demais. Tente novamente.")).toBeVisible();
    stalled = false;
    await page.getByRole("button", { name: "Tentar novamente", exact: true }).click();
    await expect(page.getByText("42", { exact: true })).toBeVisible();
    await expect(page.getByText("Confira a cobrança do provedor.")).toBeVisible();
    await expect(
      page.getByText("A conta não disponibilizou essa métrica neste período.").first(),
    ).toBeVisible();
    await page.unroute("**/api/v1/instagram/insights**");
    await page.route("**/api/v1/instagram/insights**", (route) =>
      route.fulfill({
        status: 401,
        json: { error: { code: "unauthenticated", message: "Entre novamente." } },
      }),
    );
    await context.clearCookies();
    await page.getByRole("button", { name: "Atualizar resultados" }).click();
    await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Finstagram%2Finsights/);
  } finally {
    await admin.from("organizations").delete().eq("id", org);
    await admin.auth.admin.deleteUser(user.data.user.id);
  }
});
