import { expect, test, type Page } from "@playwright/test";

// Public pages against the local app/Supabase. No session, seed, Meta call,
// callback submission or database mutation; receipt codes are synthetic.
test.use({ channel: process.env.PLAYWRIGHT_CHANNEL });

const unknownCode = "b".repeat(64);
const invalidCode = "invalid-meta-receipt";
const variants = [
  {
    locale: "pt-BR",
    instructions: "Excluir dados da conexão Meta",
    retained: "O que permanece",
    preservedConnections: "conexões sociais",
    privacy: "Política de Privacidade",
    privacyLink: "Como excluir os dados da conexão Meta",
    status: "Acompanhamento da exclusão Meta",
    missing: "Pedido não encontrado",
    back: "Instruções de exclusão e contato",
  },
  {
    locale: "es-ES",
    instructions: "Eliminar datos de la conexión con Meta",
    retained: "Qué se conserva",
    preservedConnections: "conexiones sociales",
    privacy: "Política de Privacidad",
    privacyLink: "Cómo eliminar los datos de la conexión con Meta",
    status: "Seguimiento de la eliminación de datos de Meta",
    missing: "Solicitud no encontrada",
    back: "Instrucciones de eliminación y contacto",
  },
];

async function noHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
}

for (const variant of variants) {
  for (const viewport of [
    { width: 1365, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test.describe(`${variant.locale}, ${viewport.width}px`, () => {
      test.use({ locale: variant.locale, viewport });

      test("explica exclusão, preserva escopo e protege acompanhamento público", async ({
        page,
        baseURL,
      }, testInfo) => {
        if (!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname))
          throw new Error("Local app required");
        const databaseURL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
        if (!/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(databaseURL))
          throw new Error("Local Supabase required");

        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const instructions = await page.goto("/legal/meta-data-deletion");
        expect(instructions?.status()).toBe(200);
        await expect(
          page.getByRole("heading", { level: 1, name: variant.instructions, exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("heading", { name: variant.retained, exact: true }),
        ).toBeVisible();
        await expect(page.getByRole("main")).toContainText("Studio");
        await expect(page.getByRole("main")).toContainText("CRM");
        await expect(page.getByRole("main")).toContainText(variant.preservedConnections);
        await noHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath("instructions.png"), fullPage: true });

        await page.getByRole("link", { name: variant.privacy, exact: true }).click();
        await expect(page).toHaveURL(/\/legal\/privacy$/);
        const privacyLink = page.getByRole("link", { name: variant.privacyLink, exact: true });
        await expect(privacyLink).toHaveAttribute("href", "/legal/meta-data-deletion");
        await privacyLink.click();
        await expect(page).toHaveURL(/\/legal\/meta-data-deletion$/);

        for (const query of [
          "",
          `?code=${invalidCode}`,
          `?code=${unknownCode}&code=${unknownCode}`,
          `?code=${unknownCode}`,
        ]) {
          const response = await page.goto("/legal/meta-data-deletion/status" + query);
          expect(response?.status()).toBe(200);
          const headers = response?.headers();
          expect(headers?.["cache-control"]).toContain("no-store");
          expect(headers?.["referrer-policy"]).toBe("no-referrer");
          expect(headers?.["x-robots-tag"]).toContain("noindex");
          expect(headers?.["x-robots-tag"]).toContain("nofollow");
          await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
          await expect(page.locator('meta[name="referrer"]')).toHaveAttribute(
            "content",
            "no-referrer",
          );
          await expect(
            page.getByRole("heading", { level: 1, name: variant.status, exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("heading", { level: 2, name: variant.missing, exact: true }),
          ).toBeVisible();
          const visibleText = await page.locator("body").innerText();
          expect(visibleText).not.toContain(unknownCode);
          expect(visibleText).not.toContain(invalidCode);
          expect(visibleText).not.toMatch(/Exclusão concluída|Eliminación completada/);
          await noHorizontalOverflow(page);
        }

        await page.screenshot({ path: testInfo.outputPath("unknown-status.png"), fullPage: true });
        await page.getByRole("link", { name: variant.back, exact: true }).click();
        await expect(page).toHaveURL(/\/legal\/meta-data-deletion$/);
        expect(pageErrors).toEqual([]);
      });
    });
  }
}
