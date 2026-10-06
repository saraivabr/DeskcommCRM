import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import type { AdCampaignDraftDTO, NativeAdAccount } from "@/lib/ads/types";

// Sessão/tenant e página reais no stack local. A API Meta é dublada para
// verificar o contrato da jornada; este teste não cria anúncios externos.
test.use({ channel: process.env.PLAYWRIGHT_CHANNEL });
test("Ads nativo exige escolha, revisão de orçamento e criação pausada sem fallback", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url))
    throw new Error("Local Supabase required");
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const org = randomUUID(),
    connection = randomUUID(),
    asset = randomUUID(),
    pageId = randomUUID(),
    imageId = randomUUID(),
    draftId = randomUUID();
  const email = `meta-ads-${org}@qa.local`,
    password = `QA!${randomUUID()}`;
  const user = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (user.error) throw user.error;
  const account: NativeAdAccount = {
    asset_id: asset,
    connection_id: connection,
    name: "Conta da campanha QA",
    external_id: "12",
    currency: "BRL",
    timezone: "America/Sao_Paulo",
    capabilities: { ads_read: true, ads_manage: true, instagram_publish: false },
  };
  let draft: AdCampaignDraftDTO = {
    id: draftId,
    revision: 1,
    status: "draft",
    connection_id: connection,
    ad_account_asset_id: asset,
    page_asset_id: pageId,
    name: "Campanha QA",
    objective: "OUTCOME_TRAFFIC",
    destination_url: "https://example.com/agenda",
    daily_budget_cents: 3501,
    currency: "BRL",
    starts_at: "2030-01-01T12:00:00Z",
    ends_at: "2030-01-08T12:00:00Z",
    creative: { studio_item_id: imageId, message: "Conheça a agenda", title: "Agenda disponível" },
    review_hash: "a".repeat(64),
    approved_hash: null,
    operation: null,
  };
  let campaignReads = 0,
    createCount = 0,
    legacyReads = 0;
  await page.route("**/api/v1/ads/meta/**", async (route) => {
    const request = route.request(),
      target = new URL(request.url());
    if (target.pathname.endsWith("/accounts")) {
      if (target.searchParams.get("source") !== "native") legacyReads++;
      await route.fulfill({ json: { data: { source: "native", accounts: [account] } } });
    } else if (target.pathname.endsWith("/campaigns")) {
      campaignReads++;
      expect(target.searchParams.get("asset_id")).toBe(asset);
      expect(target.searchParams.get("connection_id")).toBe(connection);
      await route.fulfill({
        json: {
          data: {
            source: "native",
            asset_id: asset,
            connection_id: connection,
            currency: "BRL",
            timezone: account.timezone,
            campanhas: [],
            periodo: {
              from: target.searchParams.get("from"),
              to: target.searchParams.get("to"),
            },
            lido_em: new Date().toISOString(),
            avisos: [],
          },
        },
      });
    } else if (target.pathname.endsWith("/approve")) {
      expect(request.postDataJSON()).toEqual({
        revision: 1,
        review_hash: draft.review_hash,
        daily_budget_cents: 3501,
        currency: "BRL",
      });
      draft = { ...draft, status: "approved", approved_hash: draft.review_hash };
      await route.fulfill({ json: { data: draft } });
    } else if (target.pathname.endsWith("/create")) {
      createCount++;
      expect(request.postDataJSON()).toEqual({ revision: 1, approved_hash: draft.review_hash });
      draft = {
        ...draft,
        status: "submitted",
        operation: {
          id: randomUUID(),
          status: "uncertain",
          stage: "campaign_created",
          external_ids: { campaign_id: "101" },
          error_message: "Confira os IDs antes de continuar.",
        },
      };
      await route.fulfill({ json: { data: draft } });
    } else if (target.pathname.endsWith(draftId)) await route.fulfill({ json: { data: draft } });
    else
      await route.fulfill({
        json: {
          data: {
            drafts: [draft],
            pages: [{ asset_id: pageId, connection_id: connection, name: "Página QA" }],
            images: [{ id: imageId, name: "Imagem pronta do Studio", preview_url: null }],
          },
        },
      });
  });
  try {
    const created = await admin.from("organizations").insert({
      id: org,
      slug: `meta-ads-${org}`,
      display_name: "Meta Ads QA",
      legal_name: "Meta Ads QA",
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
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL((value) => !value.pathname.startsWith("/login"));
    await page.goto("/app/ads/meta");
    await expect(page.getByRole("button", { name: "Conexão Meta", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const consult = page.getByRole("button", { name: "Consultar campanhas", exact: true });
    await expect(consult).toBeDisabled();
    expect(campaignReads).toBe(0);
    await page
      .getByLabel("Conta de anúncios", { exact: true })
      .selectOption(`${connection}:${asset}`);
    expect(campaignReads).toBe(0);
    await consult.click();
    await expect.poll(() => campaignReads).toBe(1);
    await page.getByRole("button", { name: "Preparar campanha", exact: true }).click();
    await page.getByRole("button", { name: "Ver revisão e resultado", exact: true }).click();
    const review = page.locator('[aria-label="Revisão da campanha"]');
    const approve = review.getByRole("button", { name: "Aprovar esta revisão", exact: true });
    await expect(approve).toBeDisabled();
    await review.getByRole("checkbox").check();
    await approve.click();
    await review.getByRole("button", { name: "Criar pausada na Meta", exact: true }).click();
    await expect(
      review.getByText("Resultado ainda não confirmado. Não crie novamente", { exact: true }),
    ).toBeVisible();
    await expect(review.getByText("101", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Criar pausada na Meta", exact: true }),
    ).toHaveCount(0);
    expect(createCount).toBe(1);
    expect(legacyReads).toBe(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: ".superpowers/evidence/meta-native/e2e-ads-review-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const accountSelect = page.getByLabel("Conta de anúncios", { exact: true });
    await expect
      .poll(async () => (await accountSelect.boundingBox())?.width ?? 0)
      .toBeGreaterThanOrEqual(250);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: ".superpowers/evidence/meta-native/e2e-ads-review-mobile.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Token manual", exact: true }).click();
    await expect(page.getByText("Nenhum token manual conectado.", { exact: true })).toBeVisible();
  } finally {
    await admin.from("organizations").delete().eq("id", org);
    await admin.auth.admin.deleteUser(user.data.user.id);
  }
});
