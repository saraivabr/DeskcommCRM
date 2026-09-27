import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

import { STORAGE_KEY } from "@/lib/theme";

test.describe("auth flow", () => {
  test("anon GET /app/inbox redirects to /login", async ({ page }) => {
    await page.goto("/app/inbox");
    // Either we land on /login (with optional ?next=) or middleware sends us elsewhere
    await page.waitForURL(/\/login/);
    expect(page.url()).toMatch(/\/login/);
  });

  test("invalid login shows error", async ({ page }) => {
    await page.goto("/login");
    await page.locator("#email").fill("nobody@example.com");
    await page.locator("#password").fill("wrong-password-xyz");
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    // Wait for either an inline error or that we did NOT navigate to /app
    await page.waitForTimeout(1500);
    expect(page.url()).not.toMatch(/\/app\//);
  });

  test("login form is keyboard navigable in tab order", async ({ page }) => {
    await page.goto("/login");
    await page.locator("#email").focus();
    await expect(page.locator("#email")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#password")).toBeFocused();
    await page.keyboard.press("Tab");
    // Next focusable is the submit button
    const submit = page.getByRole("button", { name: "Entrar", exact: true });
    await expect(submit).toBeFocused();
  });

  test("login page has no serious or critical a11y violations", async ({ page }) => {
    await page.goto("/login");
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter((v) =>
      ["serious", "critical"].includes(v.impact ?? ""),
    );
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  });

  test("a fachada de acesso cabe e continua operável nos dois temas", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(180_000);
    for (const width of [320, 390, 1440]) {
      for (const theme of ["light", "dark"] as const) {
        const context = await browser.newContext({
          viewport: { width, height: width === 1440 ? 900 : 844 },
          reducedMotion: "reduce",
        });
        try {
          await context.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), {
            key: STORAGE_KEY,
            value: theme,
          });
          const page = await context.newPage();
          await page.goto("/login");
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

          const heading = page.getByRole("heading", { name: "Entrar", level: 1 });
          const email = page.getByRole("textbox", { name: "Email" });
          const password = page.getByLabel("Senha");
          const submit = page.getByRole("button", { name: "Entrar", exact: true });
          await expect(heading).toBeVisible();
          await expect(email).toBeVisible();
          await expect(password).toBeVisible();
          await expect(submit).toBeVisible();
          expect(
            await submit.evaluate((element) => getComputedStyle(element).transitionDuration),
            `${width}px ${theme}: movimento reduzido deve remover a transição do botão`,
          ).toMatch(/^0s(?:, 0s)*$/);

          const bounds = await page.evaluate(() => {
            const controls = ["#email", "#password", "button[type=submit]"];
            return {
              documentWidth: document.body.scrollWidth,
              viewportWidth: document.documentElement.clientWidth,
              controls: controls.map((selector) => {
                const rect = document.querySelector(selector)?.getBoundingClientRect();
                return rect ? { left: rect.left, right: rect.right, width: rect.width } : null;
              }),
            };
          });
          expect(
            bounds.documentWidth,
            `${width}px ${theme}: scroll horizontal`,
          ).toBeLessThanOrEqual(bounds.viewportWidth + 1);
          for (const rect of bounds.controls) {
            expect(rect, `${width}px ${theme}: controle ausente`).not.toBeNull();
            expect(
              rect!.left,
              `${width}px ${theme}: controle cortado à esquerda`,
            ).toBeGreaterThanOrEqual(0);
            expect(
              rect!.right,
              `${width}px ${theme}: controle cortado à direita`,
            ).toBeLessThanOrEqual(bounds.viewportWidth + 1);
            expect(rect!.width, `${width}px ${theme}: controle sem largura`).toBeGreaterThan(0);
          }

          await page.screenshot({
            path: testInfo.outputPath(`login-${width}-${theme}.png`),
            fullPage: true,
          });
          if (width === 390 && theme === "dark") {
            await email.focus();
            await page.keyboard.press("Tab");
            await expect(password).toBeFocused();
            await page.keyboard.press("Tab");
            await expect(submit).toBeFocused();
            const focus = await submit.evaluate((element) => {
              const style = getComputedStyle(element);
              return { outline: style.outlineStyle, shadow: style.boxShadow };
            });
            expect(
              focus.outline !== "none" || focus.shadow !== "none",
              "o botão precisa mostrar o foco no tema escuro",
            ).toBe(true);

            const results = await new AxeBuilder({ page }).analyze();
            const blocking = results.violations.filter((violation) =>
              ["serious", "critical"].includes(violation.impact ?? ""),
            );
            expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
          }
        } finally {
          await context.close();
        }
      }
    }
  });
});
