import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { lerCreds } from "./helpers/login-admin";

const creds = lerCreds();
const taskIds = [randomUUID(), randomUUID()];
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);
test.beforeAll(async () => {
  const { data: org, error } = await db
    .from("organizations")
    .select("id")
    .eq("slug", "e2e-test-org")
    .single();
  if (error || !org) throw new Error("Organização local de teste ausente");
  const { data: users } = await db.auth.admin.listUsers();
  const owners = ["manager", "agent"].map(
    (role) => users.users.find((user) => user.email === creds.users[role]!.email)?.id,
  );
  if (owners.some((owner) => !owner)) throw new Error("Usuários de teste ausentes");
  const result = await db
    .from("crm_tasks")
    .insert(
      owners.map((owner, i) => ({
        id: taskIds[i],
        organization_id: org.id,
        title: "Home QA pendência",
        assigned_to: owner,
        due_date: "2020-01-01T12:00:00Z",
      })),
    );
  if (result.error) throw result.error;
});
test.afterAll(async () => {
  const { error } = await db.from("crm_tasks").delete().in("id", taskIds);
  if (error) throw error;
});

test.describe("Home e assistente global", () => {
  test("gestor consulta pendências reais, alterna equipe e abre o assistente pelo catálogo", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(creds.users.manager!.email);
    await page.locator("#password").fill(creds.password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL(/\/app(?:\/|$)/);
    await page.goto("/app");
    await expect(page.getByRole("heading", { name: "O que vamos resolver hoje?" })).toBeVisible();
    const scope = page.getByRole("combobox", { name: "Escopo das pendências" });
    await expect(scope).toBeEnabled();
    await expect(scope).toHaveValue("mine");
    const taskCard = page
      .getByRole("link")
      .filter({ has: page.getByRole("heading", { name: "Tarefas atrasadas", exact: true }) });
    const personal = Number(await taskCard.locator("span").first().textContent());
    expect(personal).toBeGreaterThanOrEqual(1);
    await scope.selectOption("team");
    await expect(scope).toBeEnabled();
    await expect(scope).toHaveValue("team");
    await expect
      .poll(async () => Number(await taskCard.locator("span").first().textContent()))
      .toBeGreaterThan(personal);
    await expect(page.getByRole("heading", { name: "Movimento da operação" })).toBeVisible();
    await expect(page.getByText("Consulta indisponível", { exact: true })).toHaveCount(0);
    await page
      .getByRole("navigation", { name: "Navegação principal" })
      .getByRole("link", { name: "Todas as ferramentas" })
      .click();
    await expect(page).toHaveURL(/\/app\/ferramentas/);
    await page.getByRole("button", { name: "Escreve aí", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText("Converse com sua operação. Somente leitura, com suas permissões."),
    ).toBeVisible();
    const input = dialog.getByRole("textbox", { name: "O que você quer saber sobre seu CRM?" });
    await input.fill("Minha pergunta");
    await input.press("Shift+Enter");
    await expect(input).toHaveValue("Minha pergunta\n");
    await page.screenshot({
      path: ".superpowers/evidence/home-assistente-desktop.png",
      fullPage: true,
    });
  });

  test("atendente inicia nas próprias pendências, sem opção equipe, e cabe no celular", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(creds.users.agent!.email);
    await page.locator("#password").fill(creds.password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL(/\/app(?:\/|$)/);
    await page.goto("/app");
    const scope = page.getByRole("combobox", { name: "Escopo das pendências" });
    await expect(scope).toBeEnabled();
    await expect(scope).toHaveValue("mine");
    await expect(scope.locator('option[value="team"]')).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Movimento da operação" })).toBeVisible();
    const sizes = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      content: document.body.scrollWidth,
    }));
    expect(sizes.content).toBeLessThanOrEqual(sizes.width + 1);
    await page.screenshot({
      path: ".superpowers/evidence/home-operacao-mobile.png",
      fullPage: true,
    });
  });
});
