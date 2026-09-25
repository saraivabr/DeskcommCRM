import { expect, test } from "@playwright/test";

test("sessão real protege API e abre Home, cobrança e Studio sem gerar conteúdo", async ({
  page,
  request,
}, testInfo) => {
  const anonymous = await request.get("/api/v1/instagram");
  expect(anonymous.status()).toBe(401);
  await page.goto("/app/settings/billing");
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
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
  await expect(page.getByRole("heading", { name: "O que vamos resolver hoje?" })).toBeVisible();
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
