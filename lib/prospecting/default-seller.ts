import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createMcpAgentDraft } from "@/lib/ai/agents/create-draft";
import { publishAgentVersionWithClient } from "@/lib/ai/agents/publish";
import { versionCreateSchema, type VersionInput } from "@/lib/ai/agents/validation";
import { isSubscriptionResourceLimit } from "@/lib/billing/resource-limit";
import { capabilitiesOf } from "@/lib/channels/capabilities";
import type { ChannelProvider } from "@/lib/channels/types";
import { AgentSetupError, resolveSetupModel } from "./agent-setup";
import { PROSPECTING_OPENING_GUIDANCE, PROSPECTING_REPLY_GUIDANCE } from "./conversation-guidance";
import { ProspectingError } from "./provider";
import { standardSellerProfileSchema, type StandardSellerProfile } from "./schema";

type Database = pg.Pool | pg.PoolClient;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** One identity per organization, independent of niche, campaign and request retries. */
export function standardProspectingSellerId(org: string) {
  const h = digest(["standard-prospecting-seller", org]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function loadStandardSellerProfile(
  db: Database,
  org: string,
): Promise<StandardSellerProfile> {
  const { rows } = await db.query(
    "select display_name,settings->'prospecting' as prospecting from organizations where id=$1",
    [org],
  );
  const organization = rows[0];
  if (!organization) throw new ProspectingError("Empresa não encontrada.", 404);
  const profile = organization.prospecting;
  return {
    seller_name: typeof profile?.seller_name === "string" ? profile.seller_name : "Sara",
    company_name:
      typeof profile?.company_name === "string" ? profile.company_name : organization.display_name,
    offer: typeof profile?.offer === "string" ? profile.offer : "",
  };
}

/** Atomic JSONB merge preserves other organization and prospecting settings. */
export async function saveStandardSellerProfile(db: Database, org: string, raw: unknown) {
  const parsed = standardSellerProfileSchema.safeParse(raw);
  if (!parsed.success)
    throw new ProspectingError("Confira o nome da vendedora, a empresa e o que você oferece.");
  const saved = await db.query(
    `update organizations set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{prospecting}',
      (case when jsonb_typeof(settings->'prospecting')='object' then settings->'prospecting' else '{}'::jsonb end) || $2::jsonb),updated_at=now()
     where id=$1 returning id`,
    [org, JSON.stringify(parsed.data)],
  );
  if (!saved.rows.length) throw new ProspectingError("Empresa não encontrada.", 404);
  return parsed.data;
}

export function standardProspectingSellerPrompt() {
  return `Você atua como vendedora da empresa configurada na Prospecção. A identidade comercial, a oferta, o nicho e os critérios desta conversa estão no contexto da campanha; use esses dados, sem assumir uma empresa ou um segmento fixo.
Apresente-se uma vez pelo nome e pela empresa configurados. Não use o rótulo "assistente virtual" na abertura. Se perguntarem se você é IA, responda com transparência que sim; não afirme ser uma pessoa.
Adapte o vocabulário e os exemplos ao nicho pesquisado, mantendo a mesma identidade e a oferta real da empresa. O nicho do prospect é o público da oferta, não uma mudança da empresa que você representa. Não atribua dores nem necessidades a alguém só por pertencer ao segmento.
Na primeira abordagem:
${PROSPECTING_OPENING_GUIDANCE}
Nas respostas:
${PROSPECTING_REPLY_GUIDANCE}
O contato e a oportunidade já estão no CRM. Não crie duplicatas. Consulte os dados e registre somente fatos confirmados, usando o funil e as etapas definidos no contexto desta campanha. Só avance a qualificação quando houver evidência dos critérios; saudação, resposta automática ou envio não são interesse.
Use apenas as ferramentas autorizadas e os materiais disponíveis. Nunca invente preços, resultados, disponibilidade ou condições. Só afirme que registrou, encaminhou ou agendou algo depois de confirmação. Respeite recusa, opt-out e atendimento humano.`;
}

interface Setup {
  version_id: string;
  version_hash: string;
  base_version_id: string | null;
  bootstrap_paused_at: string | null;
}
interface Agent {
  id: string;
  created_by: string | null;
  published_version_id: string | null;
  archived_at: Date | string | null;
  paused_at: Date | string | null;
  operation_mode: string;
  is_active: boolean;
  config: { managed_by?: string; standard_seller?: boolean; standard_seller_setup?: Setup };
}

function versionInput(row: Record<string, unknown>): VersionInput {
  return versionCreateSchema.parse(
    Object.fromEntries(
      Object.keys(versionCreateSchema.shape)
        .filter((key) => row[key] !== undefined && !(key === "trigger_config" && row[key] === null))
        .map((key) => [key, row[key]]),
    ),
  );
}

async function checkScopes(db: pg.PoolClient, org: string, version: VersionInput) {
  const pipelines = await db.query(
    "select id from crm_pipelines where organization_id=$1 and id=any($2::uuid[]) and not is_archived",
    [org, version.pipeline_ids],
  );
  if (new Set(pipelines.rows.map((r) => r.id)).size !== new Set(version.pipeline_ids).size)
    throw new ProspectingError("Um dos funis da prospecção não está disponível nesta empresa.");
  const sources = await db.query(
    "select id from ai_knowledge_sources where organization_id=$1 and id=any($2::uuid[]) and is_active",
    [org, version.knowledge_source_ids],
  );
  if (new Set(sources.rows.map((r) => r.id)).size !== new Set(version.knowledge_source_ids).size)
    throw new ProspectingError(
      "Um dos materiais da vendedora foi arquivado. Revise a configuração.",
    );
}

async function appendVersion(db: pg.PoolClient, org: string, agent: Agent, version: VersionInput) {
  await checkScopes(db, org, version);
  const max = await db.query<{ version_number: number }>(
    "select coalesce(max(version_number),0)::int as version_number from ai_agent_versions where organization_id=$1 and agent_id=$2",
    [org, agent.id],
  );
  const entries = Object.entries(version).filter(([, value]) => value !== undefined);
  const id = randomUUID();
  await db.query(
    `insert into ai_agent_versions(id,organization_id,agent_id,version_number,status,created_by,${entries.map(([key]) => key).join(",")})
     values($1,$2,$3,$4,'draft',$5,${entries.map((_, index) => `$${index + 6}`).join(",")})`,
    [
      id,
      org,
      agent.id,
      (max.rows[0]?.version_number ?? 0) + 1,
      agent.created_by,
      ...entries.map(([key, value]) =>
        ["followup", "trigger_config"].includes(key) ? JSON.stringify(value) : value,
      ),
    ],
  );
  return id;
}

/** Caller holds the prospecting organization lock and has no open transaction. */
export async function ensureStandardProspectingSeller(
  db: pg.PoolClient,
  _admin: SupabaseClient,
  org: string,
  input: { channel_session_id: string; pipeline_id: string },
): Promise<{ agent_id: string }> {
  const agentId = standardProspectingSellerId(org);
  const key = `prospecting-standard-seller:${org}`;
  let locked = false;
  try {
    const profile = standardSellerProfileSchema.safeParse(await loadStandardSellerProfile(db, org));
    if (!profile.success)
      throw new ProspectingError(
        "Salve o nome da vendedora, a empresa e a oferta antes de iniciar a prospecção.",
      );
    await db.query("select pg_advisory_lock(hashtextextended($1,0))", [key]);
    locked = true;
    await db.query("begin");
    const channel = await db.query(
      "select id,provider,status from channel_sessions where organization_id=$1 and id=$2 and archived_at is null",
      [org, input.channel_session_id],
    );
    const c = channel.rows[0];
    if (
      !c ||
      c.status !== "WORKING" ||
      !capabilitiesOf(c.provider as ChannelProvider).freeformOutsideWindow
    )
      throw new ProspectingError(
        "Escolha uma conexão ativa que permita iniciar conversas de texto.",
      );
    let agent = (
      await db.query<Agent>(
        "select id,created_by,published_version_id,archived_at,paused_at,operation_mode,is_active,config from ai_agents where organization_id=$1 and id=$2 for update",
        [org, agentId],
      )
    ).rows[0];
    let setup: Setup;
    let draft: VersionInput;
    if (!agent) {
      const owner = await db.query<{ user_id: string | null }>(
        `select coalesce(o.created_by,(select u.user_id from user_organizations u where u.organization_id=o.id and u.role='admin' and u.revoked_at is null and u.accepted_at is not null order by u.created_at limit 1)) as user_id from organizations o where o.id=$1`,
        [org],
      );
      const userId = owner.rows[0]?.user_id;
      if (!userId)
        throw new ProspectingError(
          "A empresa precisa de um administrador ativo para preparar a prospecção.",
        );
      const model = await resolveSetupModel(db, org, input.channel_session_id);
      draft = versionCreateSchema.parse({
        system_prompt: standardProspectingSellerPrompt(),
        provider: model.provider,
        model: model.model,
        credential_id: model.credential_id,
        channel_session_id: input.channel_session_id,
        tool_ids: [
          "crm_get_lead",
          "crm_list_leads",
          "crm_list_pipelines",
          "crm_update_lead",
          "crm_move_lead_stage",
        ],
        pipeline_ids: [input.pipeline_id],
        knowledge_source_ids: [],
        trigger_config: {
          events: ["message"],
          filters: { ignore_groups: true, ignore_self: true },
          concurrency: "one_per_conversation",
        },
      });
      setup = {
        version_id: randomUUID(),
        version_hash: digest(draft),
        base_version_id: null,
        bootstrap_paused_at: new Date().toISOString(),
      };
      const created = await createMcpAgentDraft(
        db,
        { orgId: org, userId },
        {
          name: "Vendedora de prospecção",
          description: "Vendedora padrão da Prospecção",
          employee_role: "bdr",
          version: draft,
        },
        {
          agentId,
          versionId: setup.version_id,
          pausedAt: new Date(setup.bootstrap_paused_at!),
          config: {
            managed_by: "prospecting",
            standard_seller: true,
            standard_seller_setup: setup,
          },
        },
      );
      agent = created.agent as Agent;
    } else {
      const pendingSetup = agent.config?.standard_seller_setup;
      const bootstrapPause =
        pendingSetup?.bootstrap_paused_at &&
        agent.paused_at &&
        new Date(agent.paused_at).toISOString() === pendingSetup.bootstrap_paused_at;
      if (
        agent.config?.managed_by !== "prospecting" ||
        agent.config?.standard_seller !== true ||
        agent.archived_at ||
        !agent.is_active ||
        agent.operation_mode !== "automatic" ||
        (agent.paused_at && !bootstrapPause)
      )
        throw new ProspectingError(
          "A vendedora padrão está pausada ou foi alterada. Revise a configuração antes de iniciar.",
          409,
        );
      if (pendingSetup) {
        setup = pendingSetup;
        const pending = (
          await db.query<Record<string, unknown>>(
            "select * from ai_agent_versions where organization_id=$1 and agent_id=$2 and id=$3",
            [org, agentId, setup.version_id],
          )
        ).rows[0];
        if (
          !pending ||
          digest(versionInput(pending)) !== setup.version_hash ||
          ![setup.base_version_id, setup.version_id].includes(agent.published_version_id)
        )
          throw new ProspectingError(
            "O rascunho da vendedora foi alterado. Revise a versão antes de continuar.",
            409,
          );
        draft = versionInput(pending);
        if (!draft.pipeline_ids.includes(input.pipeline_id))
          throw new ProspectingError(
            "Conclua a configuração pendente da vendedora antes de escolher outro funil.",
            409,
          );
      } else {
        const published = (
          await db.query<Record<string, unknown>>(
            "select * from ai_agent_versions where organization_id=$1 and agent_id=$2 and id=$3 and status='published'",
            [org, agentId, agent.published_version_id],
          )
        ).rows[0];
        if (!published)
          throw new ProspectingError(
            "A vendedora padrão não tem uma versão publicada válida.",
            409,
          );
        draft = versionInput(published);
        if (draft.pipeline_ids.includes(input.pipeline_id)) {
          await db.query("commit");
          return { agent_id: agentId };
        }
        const manualDraft = await db.query(
          "select id from ai_agent_versions where organization_id=$1 and agent_id=$2 and status='draft' limit 1",
          [org, agentId],
        );
        if (manualDraft.rows.length)
          throw new ProspectingError(
            "A vendedora tem um rascunho em edição. Revise-o antes de ampliar os funis da prospecção.",
            409,
          );
        draft = versionCreateSchema.parse({
          ...draft,
          pipeline_ids: [...new Set([...draft.pipeline_ids, input.pipeline_id])],
        });
        setup = {
          version_id: await appendVersion(db, org, agent, draft),
          version_hash: digest(draft),
          base_version_id: agent.published_version_id,
          bootstrap_paused_at: null,
        };
        await db.query(
          "update ai_agents set config=jsonb_set(config,'{standard_seller_setup}',$3::jsonb) where organization_id=$1 and id=$2",
          [org, agentId, JSON.stringify(setup)],
        );
      }
    }
    // Keep the draft durable if publication fails. Re-lock and revalidate it in
    // a new transaction so an editor cannot race the publication or ready flip.
    await db.query("commit");
    await db.query("begin");
    const current = (
      await db.query<Agent>(
        "select id,created_by,published_version_id,archived_at,paused_at,operation_mode,is_active,config from ai_agents where organization_id=$1 and id=$2 for update",
        [org, agentId],
      )
    ).rows[0];
    const pending = (
      await db.query<Record<string, unknown>>(
        "select * from ai_agent_versions where organization_id=$1 and agent_id=$2 and id=$3 for update",
        [org, agentId, setup.version_id],
      )
    ).rows[0];
    const pauseMatches =
      current &&
      (setup.bootstrap_paused_at
        ? current.paused_at &&
          new Date(current.paused_at).toISOString() === setup.bootstrap_paused_at
        : current.paused_at === null);
    if (
      !current ||
      current.archived_at ||
      current.operation_mode !== "automatic" ||
      !current.is_active ||
      !pauseMatches ||
      current.config?.managed_by !== "prospecting" ||
      current.config?.standard_seller !== true ||
      digest(current.config?.standard_seller_setup) !== digest(setup) ||
      ![setup.base_version_id, setup.version_id].includes(current.published_version_id) ||
      !pending ||
      digest(versionInput(pending)) !== setup.version_hash ||
      pending.status !== (current.published_version_id === setup.version_id ? "published" : "draft")
    )
      throw new ProspectingError(
        "A vendedora mudou durante a configuração. Tente novamente após revisar a versão.",
        409,
      );
    if (current.published_version_id !== setup.version_id) {
      await checkScopes(db, org, versionInput(pending));
      const result = await publishAgentVersionWithClient(db, {
        orgId: org,
        agentId,
        versionId: setup.version_id,
      });
      if (!result.ok)
        throw new ProspectingError(
          "A vendedora foi preparada, mas a publicação não foi confirmada. Confira a conexão e a chave de IA e tente novamente.",
          result.code === "internal_error" ? 500 : 422,
        );
    }
    const ready = await db.query(
      `update ai_agents set paused_at=case when $4::timestamptz is not null then null else paused_at end,config=config-'standard_seller_setup'
       where organization_id=$1 and id=$2 and published_version_id=$3 and archived_at is null and is_active and operation_mode='automatic'
       and (($4::timestamptz is not null and paused_at=$4::timestamptz) or ($4::timestamptz is null and paused_at is null)) returning id`,
      [org, agentId, setup.version_id, setup.bootstrap_paused_at],
    );
    if (!ready.rows.length)
      throw new ProspectingError(
        "A vendedora está pausada ou mudou durante a configuração. Revise antes de iniciar.",
        409,
      );
    await db.query("commit");
    return { agent_id: agentId };
  } catch (error) {
    await db.query("rollback").catch(() => undefined);
    if (error instanceof ProspectingError) throw error;
    if (error instanceof AgentSetupError) throw new ProspectingError(error.message, error.status);
    if (isSubscriptionResourceLimit(error))
      throw new ProspectingError(
        "O plano atual atingiu o limite de agentes. Confira os limites em Planos e assinatura; os recursos existentes foram preservados.",
        409,
      );
    throw new ProspectingError(
      "Não foi possível preparar a vendedora padrão. Confira a configuração e tente novamente.",
      500,
    );
  } finally {
    if (locked) await db.query("select pg_advisory_unlock(hashtextextended($1,0))", [key]);
  }
}
