/** Jornada do port visual, com funil próprio e dados sintéticos. Não envia mensagem externa. */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const env = credenciaisSupabaseDeTeste();
const db = createClient(env.url, env.serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
const credsPath = path.join(process.cwd(), ".e2e-creds.json");
interface Creds { password: string; org_id: string; users: Record<string, { id: string; email: string }> }
let creds: Creds;
const suffix = randomUUID().slice(0, 8);
const title = `Negócio visual ${suffix}`;
const taskTitle = `Próximo passo ${suffix}`;
let pipelineId = "";
let leadId = "";
let otherOrgId = "";
let otherLeadId = "";

test.describe.configure({ timeout: 120_000 });
test.use({ viewport: { width: 1440, height: 1000 } });

test.beforeAll(async () => {
  if (!fs.existsSync(credsPath)) execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  creds = JSON.parse(fs.readFileSync(credsPath, "utf8")) as Creds;
  const day = new Date();
  const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  const pipeline = await db.from("crm_pipelines").insert({
    organization_id: creds.org_id, name: `Visual ${suffix}`, slug: `visual-${suffix}`,
    settings: { fields: [
      { key: "visita", label: "Data da visita", type: "date" },
      { key: "tipo", label: "Tipo da visita", type: "text" },
      { key: "detalhe", label: "Detalhe condicional", type: "text", mostrar_quando: { campo: "tipo", igual: "Outro" } },
    ] },
  }).select("id").single();
  if (pipeline.error) throw pipeline.error;
  pipelineId = pipeline.data.id;
  const stage = await db.from("crm_stages").insert({ organization_id: creds.org_id, pipeline_id: pipelineId,
    name: "Contato inicial", slug: `inicial-${suffix}`, position: 1000 }).select("id").single();
  if (stage.error) throw stage.error;
  const lead = await db.from("crm_leads").insert({ organization_id: creds.org_id, pipeline_id: pipelineId,
    stage_id: stage.data.id, title, position_in_stage: 1000, source: "manual",
    custom_fields: { visita: date, tipo: "Padrão", detalhe: "Valor preservado" },
  }).select("id").single();
  if (lead.error) throw lead.error;
  leadId = lead.data.id;

  // Um negócio real de outra empresa faz a recusa de vínculo ter poder.
  const otherOrg = await db.from("organizations").insert({ slug: `visual-fora-${suffix}`, legal_name: "Visual fora", display_name: "Visual fora" }).select("id").single();
  if (otherOrg.error) throw otherOrg.error;
  otherOrgId = otherOrg.data.id;
  const otherPipeline = await db.from("crm_pipelines").select("id").eq("organization_id", otherOrgId).limit(1).single();
  if (otherPipeline.error) throw otherPipeline.error;
  const otherStage = await db.from("crm_stages").select("id").eq("pipeline_id", otherPipeline.data.id).limit(1).single();
  if (otherStage.error) throw otherStage.error;
  const otherLead = await db.from("crm_leads").insert({ organization_id: otherOrgId, pipeline_id: otherPipeline.data.id,
    stage_id: otherStage.data.id, title: "Não pertence a esta sessão", position_in_stage: 1000, source: "manual" }).select("id").single();
  if (otherLead.error) throw otherLead.error;
  otherLeadId = otherLead.data.id;
});

test.afterAll(async () => {
  if (leadId) {
    await db.from("crm_tasks").delete().eq("lead_id", leadId);
    await db.from("crm_lead_activities").delete().eq("lead_id", leadId);
    await db.from("crm_leads").delete().eq("id", leadId);
  }
  if (pipelineId) {
    await db.from("crm_stages").delete().eq("pipeline_id", pipelineId);
    await db.from("crm_pipelines").delete().eq("id", pipelineId);
  }
  if (otherOrgId) await db.from("organizations").delete().eq("id", otherOrgId);
});

test("calendário abre a ficha, condição preserva valor, tarefa aparece no card e Inbox tem porta", async ({ page }) => {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.manager!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(?:\/|$)/);
  await page.goto(`/app/pipelines/${pipelineId}`);
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Calendário", exact: true }).click();
  await expect(page.getByTestId("calendario-do-funil")).toBeVisible();
  await page.getByTestId(`calendario-negocio-${leadId}`).click();
  const dossier = page.getByRole("dialog", { name: title });
  await expect(dossier.getByLabel("Detalhe condicional")).toHaveCount(0);
  await dossier.getByLabel("Tipo da visita").fill("Outro");
  await expect(dossier.getByLabel("Detalhe condicional")).toHaveValue("Valor preservado");
  await dossier.getByLabel("Tipo da visita").fill("Padrão");
  await expect(dossier.getByLabel("Detalhe condicional")).toHaveCount(0);
  const [saved] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/v1/leads/${leadId}`) && r.request().method() === "PATCH"),
    dossier.getByRole("button", { name: "Salvar", exact: true }).click(),
  ]);
  expect(saved.ok()).toBeTruthy();
  await expect.poll(async () => {
    const { data } = await db.from("crm_leads").select("custom_fields").eq("id", leadId).single();
    return data?.custom_fields?.detalhe;
  }).toBe("Valor preservado");

  await dossier.getByRole("button", { name: "Nova tarefa", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Nova tarefa", exact: true });
  await form.getByLabel("O que precisa ser feito").fill(taskTitle);
  await form.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(dossier.getByText(taskTitle, { exact: true })).toBeVisible();
  const ownTask = await db.from("crm_tasks").select("id, lead_id, assigned_to").eq("organization_id", creds.org_id).eq("title", taskTitle).single();
  expect(ownTask.error).toBeNull();
  expect(ownTask.data?.lead_id).toBe(leadId);
  expect(ownTask.data?.assigned_to).toBe(creds.users.manager!.id);

  const denied = await page.request.post("/api/v1/tasks", { data: { title: "Não gravar", lead_id: otherLeadId } });
  expect(denied.status()).toBe(422);
  const deniedEdit = await page.request.patch(`/api/v1/tasks/${ownTask.data!.id}`, { data: { lead_id: otherLeadId } });
  expect(deniedEdit.status()).toBe(422);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Quadro", exact: true }).click();
  await expect(page.getByRole("img", { name: "1 tarefa aberta", exact: true })).toBeVisible();

  await page.goto("/app/inbox");
  await page.getByRole("button", { name: "Iniciar conversa", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Nova conversa", exact: true })).toBeVisible();
  // Não envia: a atribuição e recusa de tomar conversa alheia têm prova de componente própria.
});
