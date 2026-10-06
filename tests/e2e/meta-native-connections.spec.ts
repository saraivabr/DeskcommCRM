import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// Auth e organização reais no Supabase local; somente o contrato Meta é
// dublado. Este teste não demonstra OAuth, publicação ou anúncio na Meta.
test.use({ channel: process.env.PLAYWRIGHT_CHANNEL });
test("escolhe contas Meta explicitamente, comunica acesso parcial e reconexão", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url))
    throw new Error("Local Supabase required");
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const org = randomUUID(),
    connectionId = randomUUID(),
    instagramId = randomUUID(),
    adsId = randomUUID();
  const email = `meta-${org}@qa.local`,
    password = `QA!${randomUUID()}`;
  const user = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (user.error) throw user.error;
  const actorId = user.data.user.id;
  let selected: string[] = [];
  let status = "selection_pending",
    checkedAt: string | null = null;
  const connection = () => ({
    id: connectionId,
    actor_name: "Empresa de teste",
    status,
    expires_at: "2030-01-01T00:00:00Z",
    scopes: ["instagram_basic", "instagram_content_publish", "ads_read"],
    selected_asset_count: selected.length,
    reconnect_required: status === "revoked",
    checked_at: checkedAt,
  });
  const state = () => ({
    configured: true,
    capabilities: { ads_read: true, ads_manage: false, instagram_publish: true },
    connections: [connection()],
  });
  const assets = () => [
    {
      id: instagramId,
      kind: "instagram",
      name: "Café da empresa",
      external_id: "178900000123",
      username: "cafe_qa",
      currency: null,
      timezone: null,
      selected: selected.includes(instagramId),
      capabilities: { ads_read: false, ads_manage: false, instagram_publish: true },
      unavailable_reason: null,
    },
    {
      id: adsId,
      kind: "ad_account",
      name: "Anúncios da empresa",
      external_id: "act_123456789",
      username: null,
      currency: "BRL",
      timezone: "America/Sao_Paulo",
      selected: selected.includes(adsId),
      capabilities: { ads_read: true, ads_manage: false, instagram_publish: false },
      unavailable_reason: "Criação de anúncios ainda não autorizada.",
    },
  ];
  await page.route("**/api/v1/integrations/meta**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path.endsWith("/assets")) {
      const body = request.postDataJSON();
      expect(body.connection_id).toBe(connectionId);
      expect(
        body.asset_ids.every((id: string) =>
          [instagramId, adsId].some((allowed) => allowed === id),
        ),
      ).toBe(true);
      selected = body.asset_ids;
      status = selected.length > 0 ? "healthy" : "selection_pending";
      await route.fulfill({ json: { data: { assets: assets() } } });
    } else if (request.method() === "POST" && path.endsWith("/health")) {
      expect(request.postDataJSON()).toEqual({ connection_id: connectionId });
      status = "revoked";
      checkedAt = new Date().toISOString();
      await route.fulfill({ json: { data: state() } });
    } else if (path.endsWith("/assets"))
      await route.fulfill({ json: { data: { assets: assets() } } });
    else await route.fulfill({ json: { data: state() } });
  });
  await page.route("**/api/v1/channels/social**", (route) =>
    route.fulfill({
      json: {
        data: {
          label: "Integração social",
          configured: true,
          central_available: true,
          networks: [{ id: "instagram", label: "Instagram", inbox: true }],
          accounts: [],
        },
      },
    }),
  );
  try {
    const created = await admin.from("organizations").insert({
      id: org,
      slug: `meta-${org}`,
      display_name: "Meta QA",
      legal_name: "Meta QA",
      onboarded_at: new Date().toISOString(),
    });
    if (created.error) throw created.error;
    const membership = await admin.from("user_organizations").insert({
      user_id: actorId,
      organization_id: org,
      role: "admin",
      accepted_at: new Date().toISOString(),
    });
    if (membership.error) throw membership.error;
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL((value) => !value.pathname.startsWith("/login"));
    await page.goto("/app/connections?aba=sociais");
    await expect(
      page.getByRole("heading", { name: "Seu Instagram e seus anúncios, aqui" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Escolher contas", exact: true }).click();
    const instagram = page.getByRole("checkbox", { name: "Selecionar Café da empresa" });
    const ads = page.getByRole("checkbox", { name: "Selecionar Anúncios da empresa" });
    await expect(instagram).not.toBeChecked();
    await expect(ads).not.toBeChecked();
    await expect(page.getByText("Criação de anúncios ainda não autorizada.")).toBeVisible();
    await expect(page.getByText("Gerenciar anúncios", { exact: true })).toHaveCount(0);
    await instagram.check();
    await ads.check();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: ".superpowers/evidence/meta-native/e2e-selection-desktop.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Salvar contas escolhidas", exact: true }).click();
    await expect(page.getByText("2 contas escolhidas", { exact: true })).toBeVisible();
    await expect(page.getByText("Autorização válida", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Verificar conexão Empresa de teste" }).click();
    await expect(page.getByText("Autorização retirada", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reconectar Empresa de teste" })).toBeVisible();
    await expect(page.getByText("Autorização válida", { exact: true })).toHaveCount(0);
    await page.getByText("Outras conexões sociais", { exact: true }).click();
    await expect(page.getByRole("button", { name: "Autorizar conta", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: ".superpowers/evidence/meta-native/e2e-reconnect-mobile.png",
      fullPage: true,
    });
    await page.goto("/app/connections?aba=sociais&meta_error=cancelled");
    await expect(
      page.getByRole("alert").filter({ hasText: "Você cancelou a autorização" }),
    ).toHaveText(/Você cancelou a autorização/);
    await expect(page).toHaveURL(/\/app\/connections\?aba=sociais$/);
  } finally {
    await admin.from("organizations").delete().eq("id", org);
    await admin.auth.admin.deleteUser(actorId);
  }
});
