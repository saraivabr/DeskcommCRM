import { expect, test } from "@playwright/test";

test("sessão real protege API e abre Home, cobrança e Studio sem gerar conteúdo", async ({
  page,
  request,
}, testInfo) => {
  const anonymous = await request.get("/api/v1/instagram");
  expect(anonymous.status()).toBe(401);
  await page.goto("/app/settings/billing");
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
  await expect(page.getByRole("button", { name: "Entrar", exact: true })).toBeEnabled();
  await page.locator("#email").fill(process.env.OWNER_EMAIL!);
  await page.locator("#password").fill(process.env.OWNER_PASSWORD!);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page).toHaveURL(/\/app(?:\/|$)/);

  const backendErrors: string[] = [];
  let generations = 0;
  page.on("response", (response) => {
    if (response.status() >= 500 && new URL(response.url()).hostname === "localhost") {
      backendErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
    }
  });
  page.on("request", (outgoing) => {
    if (outgoing.method() === "POST" && new URL(outgoing.url()).pathname === "/api/v1/instagram")
      generations++;
  });

  await page.goto("/app");
  await expect(page.getByRole("heading", { level: 1, name: /Só escreve aí\./ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Atualizar operação" })).toBeEnabled();
  const signedIn = await page.request.get("/api/v1/instagram");
  expect(signedIn.status()).toBe(200);
  expect((await signedIn.json()).data).toMatchObject({ items: [], can_create: true });

  await page.goto("/app/settings/billing");
  await expect(page.getByRole("heading", { name: "Planos e assinatura" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Planos de assinatura" })).toBeVisible();
  await expect(
    page.getByText("Não foi possível consultar sua assinatura.", { exact: false }),
  ).toHaveCount(0);
  await page.goto("/app/instagram/new");
  await expect(page.getByLabel("O que sua empresa faz?")).toBeVisible();
  await expect(page.getByLabel("Conte sua ideia")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Gerar (minha imagem|imagem e legenda)$/ }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("studio-sem-geracao.png"), fullPage: true });
  expect(generations).toBe(0);
  expect(backendErrors).toEqual([]);
});

test("Home interrompe consulta presa, recupera pelo botão e volta ao destino após sessão expirada", async ({
  page,
  context,
}, testInfo) => {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Entrar", exact: true })).toBeEnabled();
  await page.locator("#email").fill(process.env.OWNER_EMAIL!);
  await page.locator("#password").fill(process.env.OWNER_PASSWORD!);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page).toHaveURL(/\/app(?:\/|$)/);
  await expect(page.getByRole("button", { name: "Atualizar operação" })).toBeEnabled();
  await page.clock.install();

  let calls = 0;
  let release: (() => void) | undefined;
  const stalled = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/workspace/home?*", async (route) => {
    calls++;
    if (calls === 1) {
      await stalled;
      await route.abort().catch(() => undefined);
      return;
    }
    await route.continue();
  });
  try {
    await page.goto("/app");
    await expect.poll(() => calls).toBe(1);
    const refresh = page.getByRole("button", { name: "Atualizar operação" });
    const homeError = page.getByRole("alert").filter({ hasText: "A conexão falhou. Tente de novo." });
    await expect(refresh).toBeDisabled();
    // Avança somente o relógio da página; a sessão e o banco continuam reais.
    await page.clock.fastForward(21_000);
    await expect(refresh).toBeEnabled();
    await expect(homeError).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("home-consulta-interrompida.png"), fullPage: true });
    // A ação mora na própria falha: quem leu o problema não precisa achar o ícone.
    await homeError.getByRole("button", { name: "Tentar de novo" }).click();
    await expect.poll(() => calls).toBeGreaterThan(1);
    await expect(refresh).toBeEnabled();
    await expect(homeError).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/app");

    // Expiração real no navegador de teste: o próximo GET deve sair do shell.
    await context.clearCookies();
    await refresh.click();
    await expect(page).toHaveURL(/\/login\?next=%2Fapp$/);
    await expect(page.getByRole("button", { name: "Entrar", exact: true })).toBeEnabled();
    await page.locator("#email").fill(process.env.OWNER_EMAIL!);
    await page.locator("#password").fill(process.env.OWNER_PASSWORD!);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole("button", { name: "Atualizar operação" })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("home-recuperada.png"), fullPage: true });
  } finally {
    release?.();
  }
});
