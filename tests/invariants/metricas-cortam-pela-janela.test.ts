import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { sql } from "./gov-helpers";

/**
 * #2514 — o RECORTE tem de entrar ANTES do `cross join lateral`, não depois.
 *
 * `fn_attendant_metrics` (0037) e `fn_channel_metrics` (0590) liam toda conversa
 * atribuída da organização e rodavam o lateral sobre `messages` para cada uma; a
 * janela só cortava dentro do agregado. 1 dia e 90 dias faziam o MESMO trabalho
 * (medido na issue: 13,971 s contra 14,068 s e 13,910 s contra 15,842 s) e o
 * dashboard chama as duas com janela curta a cada visita.
 *
 * Duas provas, contra o banco REAL do baseline (o que os testes de texto não
 * alcançam):
 *
 *   1. **Paridade** — a saída da função NOVA é idêntica, byte a byte, à da
 *      régua ANTIGA (`ref_fn_*`, criada aqui a partir do corpo anterior e
 *      chamada sob a mesma RLS), para as duas funções, para janela curta e
 *      longa, como manager e como agent. O critério da issue é este: só o custo
 *      cai, o número não muda. As linhas de caso de borda são de propósito —
 *      conversa atribuída FORA da janela mas respondida DENTRO (só a média),
 *      atribuída DENTRO sem mensagem nenhuma (só a contagem/vazamento), e
 *      atribuída fora sem nada (era só peso morto do lateral).
 *
 *   2. **Custo proporcional à janela** — `EXPLAIN (ANALYZE, FORMAT JSON)` com o
 *      papel `authenticated` e `statement_timeout` de 8 s (o teto do banco
 *      real), contando as Vezes (`Actual Loops`) dos nós que tocam `messages`:
 *      é o número de conversas para as quais o lateral rodou. Curto tem de ser
 *      MENOR que longo — com a régua antiga os dois números são idênticos,
 *      porque a janela não entrava em lugar nenhum antes do trabalho.
 *
 * Namespace c2514… (exclusivo deste arquivo). Sem PII: @invariant.test.
 * Timestamps LITERAIS para agregações determinísticas.
 */

const ORG = "c2514000-0000-4000-8000-000000000001"; // casos de borda
const ORG_VOLUME = "c2514000-0000-4000-8000-000000000002"; // volume sintético
const AGENT = "c2514111-0000-4000-8000-000000000001";
const MANAGER = "c2514111-0000-4000-8000-000000000002";
const OUTRO = "c2514111-0000-4000-8000-000000000003";
const SESSION = "c2514222-0000-4000-8000-000000000001";
const SESSION_VOLUME = "c2514222-0000-4000-8000-000000000002";

/** Conversas de borda: cada uma cobre uma razão de o recorte ser EXATO. */
const CV_DENTRO = "c2514555-0000-4000-8000-000000000001"; // atribuída e respondida dentro
const CV_FORA_RESP = "c2514555-0000-4000-8000-000000000002"; // atribuída fora, respondida dentro
const CV_DENTRO_SEM_MSG = "c2514555-0000-4000-8000-000000000003"; // dentro, sem mensagem alguma
const CV_FORA_SEM_MSG = "c2514555-0000-4000-8000-000000000004"; // fora, sem mensagem alguma
const CV_BOT = "c2514555-0000-4000-8000-000000000005"; // dentro, só a IA respondeu
const CV_FORA_BOT = "c2514555-0000-4000-8000-000000000006"; // fora, só a IA dentro da janela
const CV_DEPOIS = "c2514555-0000-4000-8000-000000000007"; // dentro, resposta DEPOIS do fim
const CV_OUTRO_AGENTE = "c2514555-0000-4000-8000-000000000008"; // dentro, dono outro (RLS)

const CT = (n: number) => `('c2514444-0000-4000-8000-00000000000${n}')::uuid`;

const DE = "2026-07-01T00:00:00+00";
const ATE = "2026-07-31T00:00:00+00"; // 30 dias
const DE_CURTO = "2026-07-15"; // só a data: as seeds fazem '${DE_CURTO}T10:00:00+00'
const ATE_CURTO = "2026-07-16T00:00:00+00"; // 1 dia

/** Volume sintético: 600 conversas em 120 dias, 4 mensagens cada. */
const VOLUME = 600;
const VOLUME_DE = "2026-06-01T00:00:00+00";
const VOLUME_ATE = "2026-08-30T00:00:00+00"; // 90 dias
const VOLUME_DE_CURTO = "2026-07-20T00:00:00+00";
const VOLUME_ATE_CURTO = "2026-07-21T00:00:00+00"; // 1 dia

/**
 * A RÉGUA ANTIGA — o corpo de cada função ANTES da migration 0591, escrito aqui
 * como função de referência (`ref_fn_*`). É a comparação que a issue pede
 * ("paridade provada contra a régua atual"): a função nova e esta têm de
 * devolver o MESMO jsonb para o MESMO recorte, sob a MESMA RLS.
 */
const REF_ATENDENTES = `
create or replace function public.ref_fn_attendant_metrics(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_owner uuid default null
) returns jsonb
language sql stable
set search_path = public
as $ref$
  with
  lead_agg as (
    select
      owner_user_id as user_id,
      count(*) filter (where status = 'won')  as won,
      count(*) filter (
        where status = 'lost'
          and coalesce(lost_reason, '') <> 'moved_to_another_pipeline'
      ) as lost
    from public.crm_leads
    where organization_id = p_org
      and status in ('won', 'lost')
      and closed_at >= p_from and closed_at < p_to
      and owner_user_id is not null
      and (p_owner is null or owner_user_id = p_owner)
    group by owner_user_id
  ),
  conv_agg as (
    select
      assigned_to_user_id as user_id,
      count(*) as conversations_handled
    from public.conversations
    where organization_id = p_org
      and assigned_to_user_id is not null
      and assigned_at >= p_from and assigned_at < p_to
      and (p_owner is null or assigned_to_user_id = p_owner)
    group by assigned_to_user_id
  ),
  voice_agg as (
    select
      owner_user_id as user_id,
      count(*) as calls_answered,
      coalesce(sum(duration_ms), 0)::bigint as call_ms
    from public.voice_calls
    where organization_id = p_org
      and owner_user_id is not null
      and answered_at is not null
      and answered_at >= p_from and answered_at < p_to
      and (p_owner is null or owner_user_id = p_owner)
    group by owner_user_id
  ),
  ttfr as (
    select
      c.assigned_to_user_id as user_id,
      avg(extract(epoch from (fr.first_human_out - fr.first_in))) as avg_first_response_seconds
    from public.conversations c
    cross join lateral (
      select
        min(m.sent_at) filter (where m.direction = 'inbound') as first_in,
        min(m.sent_at) filter (
          where m.direction = 'outbound' and m.sent_by_user_id is not null
        ) as first_human_out
      from public.messages m
      where m.conversation_id = c.id
    ) fr
    where c.organization_id = p_org
      and c.assigned_to_user_id is not null
      and (p_owner is null or c.assigned_to_user_id = p_owner)
      and fr.first_in is not null
      and fr.first_human_out is not null
      and fr.first_human_out > fr.first_in
      and fr.first_human_out >= p_from and fr.first_human_out < p_to
    group by c.assigned_to_user_id
  ),
  attendant_ids as (
    select user_id from lead_agg
    union select user_id from conv_agg
    union select user_id from ttfr
    union select user_id from voice_agg
  )
  select jsonb_build_object(
    'attendants', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'user_id', a.user_id,
          'won', coalesce(la.won, 0),
          'lost', coalesce(la.lost, 0),
          'conversations_handled', coalesce(ca.conversations_handled, 0),
          'avg_first_response_seconds', tf.avg_first_response_seconds,
          'calls_answered', coalesce(va.calls_answered, 0),
          'call_seconds', (coalesce(va.call_ms, 0) / 1000)::bigint
        ) order by coalesce(la.won, 0) desc, a.user_id
      )
      from attendant_ids a
      left join lead_agg la on la.user_id = a.user_id
      left join conv_agg ca on ca.user_id = a.user_id
      left join ttfr tf on tf.user_id = a.user_id
      left join voice_agg va on va.user_id = a.user_id
    ), '[]'::jsonb)
  );
$ref$;
`;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${AGENT}',   'r2514-agent@invariant.test'),
      ('${MANAGER}', 'r2514-manager@invariant.test'),
      ('${OUTRO}',   'r2514-outro@invariant.test')
    on conflict do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}',         'r2514-borda',   'R2514 Bordas Org',   'R2514 Bordas'),
      ('${ORG_VOLUME}',  'r2514-volume',  'R2514 Volume Org',   'R2514 Volume')
    on conflict do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${AGENT}',   '${ORG}', 'agent',   now()),
      ('${MANAGER}', '${ORG}', 'manager', now()),
      ('${OUTRO}',   '${ORG}', 'agent',   now()),
      ('${MANAGER}', '${ORG_VOLUME}', 'manager', now()),
      ('${AGENT}',   '${ORG_VOLUME}', 'agent',   now())
    on conflict do nothing;

    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, display_name) values
      ('${SESSION}',        '${ORG}',        'r2514-s1', '\\x00'::bytea, 'Numero 2514'),
      ('${SESSION_VOLUME}', '${ORG_VOLUME}', 'r2514-s2', '\\x00'::bytea, 'Volume 2514');

    -- Casos de borda: um por razão de o recorte poder (ou não) cortar.
    insert into public.contacts (id, organization_id, display_name) values
      ${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `(${CT(n)}, '${ORG}', 'R2514 Contato ${n}')`).join(",\n      ")};

    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at, assignee_kind)
    values
      -- dentro da janela, respondida dentro: contagem E média
      ('${CV_DENTRO}',        '${ORG}', ${CT(1)}, '${SESSION}', 'claimed', '${AGENT}',   '${DE_CURTO}T10:00:00+00', 'user'),
      -- atribuída ANTES da janela, 1ª resposta humana DENTRO: SÓ a média.
      -- É a linha que um recorte só por assigned_at perderia.
      ('${CV_FORA_RESP}',     '${ORG}', ${CT(2)}, '${SESSION}', 'claimed', '${AGENT}',   '2026-06-20T10:00:00+00', 'user'),
      -- dentro da janela e sem mensagem nenhuma: contagem E vazamento, lateral nulo
      ('${CV_DENTRO_SEM_MSG}','${ORG}', ${CT(3)}, '${SESSION}', 'claimed', '${AGENT}',   '${DE_CURTO}T11:00:00+00', 'user'),
      -- fora da janela e sem mensagem nenhuma: não soma nada — era peso morto
      ('${CV_FORA_SEM_MSG}',  '${ORG}', ${CT(4)}, '${SESSION}', 'claimed', '${AGENT}',   '2026-05-01T10:00:00+00', 'user'),
      -- dentro, só a IA respondeu: contagem, sem média (bot fica de fora)
      ('${CV_BOT}',           '${ORG}', ${CT(5)}, '${SESSION}', 'claimed', '${AGENT}',   '${DE_CURTO}T12:00:00+00', 'user'),
      -- fora, com mensagem humana DENTRO da janela mas depois de uma anterior
      -- à janela: a 1ª resposta é fora, logo não conta — não é candidata
      ('${CV_FORA_BOT}',      '${ORG}', ${CT(6)}, '${SESSION}', 'claimed', '${AGENT}',   '2026-06-10T10:00:00+00', 'user'),
      -- dentro, mas a resposta humana só chega DEPOIS do fim da janela
      ('${CV_DEPOIS}',        '${ORG}', ${CT(7)}, '${SESSION}', 'claimed', '${AGENT}',   '${DE_CURTO}T13:00:00+00', 'user'),
      -- dentro, dono outro: a RLS de conversations decide quem enxerga
      ('${CV_OUTRO_AGENTE}',  '${ORG}', ${CT(8)}, '${SESSION}', 'claimed', '${OUTRO}',   '${DE_CURTO}T14:00:00+00', 'user');

    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, sent_via, sent_by_user_id, sent_at)
    values
      ('${ORG}', '${CV_DENTRO}', '${SESSION}', ${CT(1)}, 'text', 'inbound',  'crm',  null,          '${DE_CURTO}T10:00:00+00'),
      ('${ORG}', '${CV_DENTRO}', '${SESSION}', ${CT(1)}, 'text', 'outbound', 'user', '${AGENT}',    '${DE_CURTO}T10:01:00+00'),
      ('${ORG}', '${CV_FORA_RESP}', '${SESSION}', ${CT(2)}, 'text', 'inbound',  'crm',  null,       '2026-06-20T10:00:00+00'),
      ('${ORG}', '${CV_FORA_RESP}', '${SESSION}', ${CT(2)}, 'text', 'outbound', 'user', '${AGENT}', '${DE_CURTO}T10:30:00+00'),
      ('${ORG}', '${CV_BOT}', '${SESSION}', ${CT(5)}, 'text', 'inbound',  'crm',  null,        '${DE_CURTO}T12:00:00+00'),
      ('${ORG}', '${CV_BOT}', '${SESSION}', ${CT(5)}, 'text', 'outbound', 'ai',   null,        '${DE_CURTO}T12:00:10+00'),
      ('${ORG}', '${CV_FORA_BOT}', '${SESSION}', ${CT(6)}, 'text', 'inbound',  'crm',  null,    '2026-06-10T10:00:00+00'),
      ('${ORG}', '${CV_FORA_BOT}', '${SESSION}', ${CT(6)}, 'text', 'outbound', 'user', '${AGENT}', '2026-06-10T10:05:00+00'),
      ('${ORG}', '${CV_FORA_BOT}', '${SESSION}', ${CT(6)}, 'text', 'inbound',  'crm',  null,    '${DE_CURTO}T09:00:00+00'),
      ('${ORG}', '${CV_FORA_BOT}', '${SESSION}', ${CT(6)}, 'text', 'outbound', 'user', '${AGENT}', '${DE_CURTO}T09:30:00+00'),
      ('${ORG}', '${CV_DEPOIS}', '${SESSION}', ${CT(7)}, 'text', 'inbound',  'crm',  null,       '${DE_CURTO}T13:00:00+00'),
      ('${ORG}', '${CV_DEPOIS}', '${SESSION}', ${CT(7)}, 'text', 'outbound', 'user', '${AGENT}', '2026-08-05T13:01:00+00'),
      ('${ORG}', '${CV_OUTRO_AGENTE}', '${SESSION}', ${CT(8)}, 'text', 'inbound',  'crm',  null,  '${DE_CURTO}T14:00:00+00'),
      ('${ORG}', '${CV_OUTRO_AGENTE}', '${SESSION}', ${CT(8)}, 'text', 'outbound', 'user', '${OUTRO}', '${DE_CURTO}T14:01:00+00');

    -- Volume sintético: 600 conversas atribuídas em 120 dias, 4 mensagens cada.
    -- É o tamanho que a issue mediu (3.000 conversas / 12.000 mensagens), na
    -- mesma proporção, para o corte de custo ter o que cortar.
    insert into public.contacts (id, organization_id, display_name)
    select ('c2514445-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
           '${ORG_VOLUME}', 'R2514 Volume Contato ' || g
    from generate_series(1, ${VOLUME}) g;

    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at, assignee_kind)
    select ('c2514556-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
           '${ORG_VOLUME}',
           ('c2514445-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
           '${SESSION_VOLUME}',
           'claimed',
           case when g % 4 = 0 then '${AGENT}'::uuid else '${MANAGER}'::uuid end,
           timestamp with time zone '${VOLUME_DE}' + ((g * 7) % 120) * interval '1 day' + (g % 24) * interval '1 hour',
           'user'
    from generate_series(1, ${VOLUME}) g;

    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, sent_via, sent_by_user_id, sent_at)
    select '${ORG_VOLUME}',
           ('c2514556-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
           '${SESSION_VOLUME}',
           ('c2514445-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
           'text',
           caso.direction,
           caso.sent_via,
           caso.sent_by_user_id,
           caso.sent_at
    from generate_series(1, ${VOLUME}) g
    cross join lateral (
      values
        ('inbound',  'crm',  null::uuid,                   timestamp with time zone '${VOLUME_DE}' + ((g * 7) % 120) * interval '1 day' + (g % 24) * interval '1 hour'),
        ('outbound', 'ai',   null::uuid,                   timestamp with time zone '${VOLUME_DE}' + ((g * 7) % 120) * interval '1 day' + (g % 24) * interval '1 hour' + interval '10 seconds'),
        ('outbound', 'user', '${AGENT}'::uuid,             timestamp with time zone '${VOLUME_DE}' + ((g * 7) % 120) * interval '1 day' + (g % 24) * interval '1 hour' + interval '60 seconds'),
        ('outbound', 'user', '${MANAGER}'::uuid,           timestamp with time zone '${VOLUME_DE}' + ((g * 7) % 120) * interval '1 day' + (g % 24) * interval '1 hour' + interval '300 seconds')
    ) as caso(direction, sent_via, sent_by_user_id, sent_at);

    ${REF_ATENDENTES}
    
  `);
});

function como(actor: string): string {
  return `set role authenticated;
    do $c$ begin perform set_config('request.jwt.claims', '{"sub":"${actor}"}', false); end $c$;`;
}

/** A chave da saída que as duas funções devolvem (o resto é idêntico no código). */
const chave = (_func: string) => "attendants";

/**
 * A RPC NOVA e a régua de REFERÊNCIA na MESMA sessão, sob a MESMA RLS, recortadas
 * pela mesma chave — a comparação é byte a byte do jsonb.
 */
function expectParidade(func: string, actor: string, org: string, de: string, ate: string) {
  const out = sql(`
    ${como(actor)}
    select 'NOVO:' || (public.${func}('${org}', '${de}', '${ate}', null) -> '${chave(func)}')::text
      || E'\\nREF:' || (public.ref_${func}('${org}', '${de}', '${ate}', null) -> '${chave(func)}')::text;
  `);
  const linhas = out.split("\n");
  const novo = linhas.find((l) => l.startsWith("NOVO:"));
  const ref = linhas.find((l) => l.startsWith("REF:"));
  expect(novo, `a saída da RPC nova não chegou: ${out.slice(0, 200)}`).toBeDefined();
  expect(ref, `a saída da régua de referência não chegou: ${out.slice(0, 200)}`).toBeDefined();
  expect(JSON.parse(novo!.slice(5))).toEqual(JSON.parse(ref!.slice(4)));
}

type NoPlano = {
  "Node Type"?: string;
  "Relation Name"?: string;
  "Actual Loops"?: number;
  Plans?: NoPlano[];
  [chave: string]: unknown;
};

function coleta(no: NoPlano, acc: NoPlano[]): NoPlano[] {
  acc.push(no);
  for (const filho of no.Plans ?? []) coleta(filho, acc);
  return acc;
}

/** `EXPLAIN (ANALYZE, FORMAT JSON)` da RPC, sob RLS e com o teto de 8 s. */
function medir(_func: string, org: string, de: string, ate: string): { loops: number; ms: number } {
  const migration = readFileSync("supabase/migrations/20261016082200_0422_recorte_da_janela_nas_metricas.sql", "utf8");
  const query = migration.split("as $$")[1]!.split("$$;")[0]!
    .replace(/\bp_org\b/g, `'${org}'::uuid`)
    .replace(/\bp_from\b/g, `'${de}'::timestamptz`)
    .replace(/\bp_to\b/g, `'${ate}'::timestamptz`)
    .replace(/\bp_owner\b/g, 'null::uuid');
  const out = sql(`
    ${como(MANAGER)}
    set statement_timeout = '8s';
    explain (analyze, format json)
      ${query}
  `);
  const linhas = out.split("\n");
  const ini = linhas.findIndex((l) => l.trim() === "[");
  const fim = linhas.findLastIndex((l) => l.trim() === "]");
  expect(ini, `EXPLAIN devolveu algo inesperado: ${out.slice(0, 300)}`).toBeGreaterThan(-1);
  const json = JSON.parse(linhas.slice(ini, fim + 1).join("\n")) as Array<{ Plan: NoPlano; "Execution Time": number }>;
  const nos = coleta(json[0]!.Plan, []);
  const tocamMensagens = nos.filter(
    (n) => n["Relation Name"] === "messages" || n["Node Type"] === "SubPlan" || n["Node Type"] === "SubPlan (initoff)",
  );
  expect(
    tocamMensagens.length,
    `o plano não mostrou o lateral sobre messages — o instrumento perdeu o alvo: ${nos
      .map((n) => n["Node Type"])
      .join(", ")}`,
  ).toBeGreaterThan(0);
  const loops = Math.max(...tocamMensagens.map((n) => Number(n["Actual Loops"] ?? 0)));
  const ms = Number(json[0]!["Execution Time"]);
  return { loops, ms };
}

describe("#2514 — o recorte antes do lateral", () => {
  it("paridade das métricas de atendentes contra a régua antiga, janela curta e longa, manager e agent", () => {
    // Casos de borda da organização pequena, como manager (organização inteira).
    expectParidade("fn_attendant_metrics", MANAGER, ORG, DE_CURTO, ATE_CURTO);
    expectParidade("fn_attendant_metrics", MANAGER, ORG, DE, ATE);
    // Mesmo recorte com a RLS de agent (só as próprias conversas).
    expectParidade("fn_attendant_metrics", AGENT, ORG, DE, ATE);
    // Volume sintético: a paridade tem de valer com 600 conversas, não só com 8.
    expectParidade("fn_attendant_metrics", MANAGER, ORG_VOLUME, VOLUME_DE_CURTO, VOLUME_ATE_CURTO);
    expectParidade("fn_attendant_metrics", MANAGER, ORG_VOLUME, VOLUME_DE, VOLUME_ATE);
  });

  it("a média da janela curta traz a conversa atribuída FORA — recortar por `assigned_at` só mudaria o número", () => {
    // Controle da paridade: ela só significa alguma coisa se as duas consultas
    // forem de fato diferentes. No dia 15/07 o AGENT tem DUAS conversas com
    // resposta humana dentro da janela: CV_DENTRO (atribuída dentro, 60 s) e
    // CV_FORA_RESP (atribuída em 20/06, 25 dias + 30 min). Um pré-filtro que
    // cortasse só por `assigned_at` devolveria 60; a régua devolve a média das
    // duas — é o número que o recorte tem de preservar.
    const out = sql(`
      ${como(MANAGER)}
      with r as (
        select public.fn_attendant_metrics('${ORG}', '${DE_CURTO}', '${ATE_CURTO}', null) as j
      )
      select 'ROW:' || coalesce((x ->> 'avg_first_response_seconds')::text, 'nulo')
      from r, jsonb_array_elements(r.j -> 'attendants') x
      where x ->> 'user_id' = '${AGENT}';
    `);
    const media = Number(out.split("\n").pop()!.replace(/^ROW:/, ""));
    expect(media).toBe((60 + (25 * 86400 + 1800)) / 2);
    expect(media).not.toBe(60);
  });

  it.each([
    ["fn_attendant_metrics"],
  ])("%s: janela de 1 dia roda o lateral para MENOS conversas que janela de 90", (func) => {
    const curto = medir(func, ORG_VOLUME, VOLUME_DE_CURTO, VOLUME_ATE_CURTO);
    const longo = medir(func, ORG_VOLUME, VOLUME_DE, VOLUME_ATE);
    // eslint-disable-next-line no-console
    console.log(
      `[2514] ${func}: 1 dia = ${curto.loops} execuções do lateral em ${curto.ms.toFixed(1)} ms · ` +
        `${Math.round((Date.parse(VOLUME_ATE) - Date.parse(VOLUME_DE)) / 86400000)} dias = ${longo.loops} execuções em ${longo.ms.toFixed(1)} ms`,
    );
    expect(
      curto.loops,
      `janela curta tocou ${curto.loops} conversas e a longa ${longo.loops} — o recorte não entrou antes do lateral`,
    ).toBeLessThan(longo.loops);
    // Tempo varia com cache e carga do runner; trabalho medido pelo plano é o gate.
    expect(Number.isFinite(curto.ms) && Number.isFinite(longo.ms)).toBe(true);
  });
});
