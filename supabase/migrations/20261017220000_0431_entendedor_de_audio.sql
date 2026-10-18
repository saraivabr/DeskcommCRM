-- manifest: Entendedor de áudio — configuração por organização, franquia mensal em segundos e reserva atômica por mensagem (dedupe por message_id, liquidação só depois do envio aceito).
--
-- ─── O que isto resolve ─────────────────────────────────────────────────────
-- O entendedor lê o áudio que chega numa conexão de WhatsApp da organização e
-- devolve, na própria conversa, uma nota curta do que importa. Até aqui ele
-- vivia fora do CRM (fluxo de automação + banco próprio), com dois defeitos que
-- esta migration fecha no schema:
--
--   1. Consumo lido e somado fora de transação: dois áudios simultâneos da
--      mesma organização perdiam um incremento. Aqui a reserva é feita sob
--      `pg_advisory_xact_lock` por organização, e a soma do período é
--      calculada das linhas, nunca de um contador copiado.
--   2. Reprocessar um áudio podia mandar a nota duas vezes. Aqui
--      `unique (organization_id, message_id)` é a chave da reserva: a segunda
--      tentativa recebe a reserva existente em vez de criar outra.
--
-- ─── Destino ────────────────────────────────────────────────────────────────
-- Núcleo desta edição: o entendedor é a porta de entrada gratuita do produto.
-- Mesmo assim ele nasce DESLIGADO por organização (`enabled = false`): quem
-- não liga não tem uma linha sequer nesta tabela e a operação comum segue
-- inteira — é a régua de docs/doctrine/extensoes.md.
--
-- ─── Franquia ───────────────────────────────────────────────────────────────
-- `monthly_limit_seconds` nulo = vale o padrão da instalação (30 min/mês, em
-- lib/entendedor/franquia.ts). O período é o mês civil de São Paulo, passado
-- pelo chamador como `date` (o primeiro dia do mês) para a função não depender
-- do fuso da sessão do banco.

create table if not exists public.audio_understanding_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  enabled boolean not null default false,
  process_received boolean not null default true,
  process_sent boolean not null default false,
  groups_enabled boolean not null default false,
  show_understanding boolean not null default true,
  show_spoken_text boolean not null default true,
  monthly_limit_seconds integer,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint audio_understanding_settings_limite_valido
    check (monthly_limit_seconds is null or monthly_limit_seconds between 0 and 31536000),
  constraint audio_understanding_settings_alguma_saida
    check (show_understanding or show_spoken_text)
);

comment on table public.audio_understanding_settings is
  'Entendedor de áudio: liga/desliga e preferências por organização. Sem linha = desligado.';

create table if not exists public.audio_understanding_usage (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- `set null`, não cascade: a linha é o registro de consumo do período e
  -- sobrevive à anonimização ou remoção da mensagem (anti-padrão 7).
  message_id uuid references public.messages(id) on delete set null,
  period_start date not null,
  seconds integer not null,
  status text not null default 'reserved',
  reply_message_id uuid references public.messages(id) on delete set null,
  failure_reason text,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  constraint audio_understanding_usage_status_valido
    check (status in ('reserved', 'charged', 'released')),
  constraint audio_understanding_usage_segundos_validos
    check (seconds > 0 and seconds <= 86400),
  constraint audio_understanding_usage_mensagem_unica
    unique (organization_id, message_id)
);

create index if not exists audio_understanding_usage_periodo_idx
  on public.audio_understanding_usage (organization_id, period_start)
  where status in ('reserved', 'charged');

comment on table public.audio_understanding_usage is
  'Entendedor de áudio: uma linha por áudio admitido. reserved = em processamento; charged = nota enviada e descontada; released = falhou e devolveu a franquia.';

alter table public.audio_understanding_settings enable row level security;
alter table public.audio_understanding_usage enable row level security;

drop policy if exists tenant_isolation_audio_understanding_settings_select on public.audio_understanding_settings;
create policy tenant_isolation_audio_understanding_settings_select on public.audio_understanding_settings
  for select
  using (organization_id in (select * from public.fn_user_org_ids()));

-- Escrita pela RLS só para admin: a rota usa a mesma régua, e a regra precisa
-- sobreviver a uma rota nova que esqueça o requireRole.
drop policy if exists tenant_isolation_audio_understanding_settings_write on public.audio_understanding_settings;
create policy tenant_isolation_audio_understanding_settings_write on public.audio_understanding_settings
  for all
  using (
    organization_id in (select * from public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  )
  with check (
    organization_id in (select * from public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  );

-- Consumo: membros leem; ninguém escreve pela REST. Só o worker (service role)
-- e as duas funções abaixo mexem nas linhas.
drop policy if exists tenant_isolation_audio_understanding_usage_select on public.audio_understanding_usage;
create policy tenant_isolation_audio_understanding_usage_select on public.audio_understanding_usage
  for select
  using (organization_id in (select * from public.fn_user_org_ids()));

revoke all on public.audio_understanding_settings from anon;
revoke all on public.audio_understanding_usage from anon;
revoke insert, update, delete, truncate on public.audio_understanding_usage from authenticated;

-- ─── Reserva atômica ────────────────────────────────────────────────────────
-- Devolve uma linha: `admitido` diz se o áudio pode seguir; `motivo` explica a
-- recusa ('franquia_esgotada') ou a repetição ('ja_reservado', 'ja_cobrado',
-- 'ja_liberado'). `usados` é o consumo do período DEPOIS da reserva.
create or replace function public.fn_entendedor_reservar(
  p_organization_id uuid,
  p_message_id uuid,
  p_seconds integer,
  p_limit_seconds integer,
  p_period_start date
)
returns table (admitido boolean, motivo text, usados integer, limite integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existente text;
  v_usados integer;
begin
  if p_seconds is null or p_seconds <= 0 then
    raise exception 'entendedor: duração inválida' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('entendedor:' || p_organization_id::text));

  select u.status into v_existente
    from public.audio_understanding_usage u
   where u.organization_id = p_organization_id
     and u.message_id = p_message_id;

  select coalesce(sum(u.seconds), 0)::integer into v_usados
    from public.audio_understanding_usage u
   where u.organization_id = p_organization_id
     and u.period_start = p_period_start
     and u.status in ('reserved', 'charged');

  if v_existente is not null then
    return query select (v_existente = 'reserved'), 'ja_' || case v_existente
      when 'reserved' then 'reservado' when 'charged' then 'cobrado' else 'liberado' end,
      v_usados, p_limit_seconds;
    return;
  end if;

  -- O áudio inteiro precisa caber: nota pela metade não existe.
  if v_usados + p_seconds > p_limit_seconds then
    return query select false, 'franquia_esgotada'::text, v_usados, p_limit_seconds;
    return;
  end if;

  insert into public.audio_understanding_usage (organization_id, message_id, period_start, seconds)
  values (p_organization_id, p_message_id, p_period_start, p_seconds);

  return query select true, 'reservado'::text, v_usados + p_seconds, p_limit_seconds;
end;
$$;

revoke execute on function public.fn_entendedor_reservar(uuid, uuid, integer, integer, date) from public, anon, authenticated;
grant execute on function public.fn_entendedor_reservar(uuid, uuid, integer, integer, date) to service_role;

-- ─── Liquidação ─────────────────────────────────────────────────────────────
-- `charged` só depois do envio aceito pelo canal; `released` devolve a
-- franquia. Só sai de `reserved`: uma nota já cobrada nunca vira liberada por
-- uma tentativa atrasada.
create or replace function public.fn_entendedor_liquidar(
  p_organization_id uuid,
  p_message_id uuid,
  p_status text,
  p_reply_message_id uuid,
  p_failure_reason text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_linhas integer;
begin
  if p_status not in ('charged', 'released') then
    raise exception 'entendedor: status de liquidação inválido' using errcode = '22023';
  end if;

  update public.audio_understanding_usage
     set status = p_status,
         reply_message_id = p_reply_message_id,
         failure_reason = left(p_failure_reason, 200),
         settled_at = now()
   where organization_id = p_organization_id
     and message_id = p_message_id
     and status = 'reserved';
  get diagnostics v_linhas = row_count;
  return v_linhas = 1;
end;
$$;

revoke execute on function public.fn_entendedor_liquidar(uuid, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_entendedor_liquidar(uuid, uuid, text, uuid, text) to service_role;
