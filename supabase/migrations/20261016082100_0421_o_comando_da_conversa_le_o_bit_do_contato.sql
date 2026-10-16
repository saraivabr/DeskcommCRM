-- 0421: o comando da conversa lê o bit do contato (issue #2739).
--
-- Detalhe completo no cabeçalho do bloco abaixo; o bloco é o MESMO, letra a
-- letra, no apêndice de `supabase/baseline.sql` — é ele que o `update.sh`
-- reaplica a cada atualização, inclusive em quem nunca vai rodar migrations.

-- ---- o comando da conversa lê o bit do contato (migration 0421, issue #2739) ----
-- A trava do contato que o campo calculado `comando_da_conversa` lia POR LINHA
-- (duas subconsultas a `contacts` por conversa) passa a viver na própria
-- conversa, num bit mantido por gatilho; a função só lê a linha. O prazo do
-- silêncio continua avaliado NA CONSULTA, com `now()` de verdade — nunca
-- congelado na escrita (o defeito que derrubou o #1921).

alter table public.conversations
  add column if not exists contato_trava_humano boolean not null default false;

comment on column public.conversations.contato_trava_humano is
  'contacts.force_human OR contacts.is_blocked, mantido pelo gatilho (issue #2739). O campo calculado comando_da_conversa lê ESTE bit em vez de resolver o contato por linha.';

-- Backfill do que já existe. Só as linhas divergentes são tocadas: o update.sh
-- reaplica este apêndice a cada atualização, e reescrever a tabela inteira toda
-- vez seria custo sem mudança.
update public.conversations c
   set contato_trava_humano = (ct.force_human or ct.is_blocked)
  from public.contacts ct
 where ct.id = c.contact_id
   and ct.organization_id = c.organization_id
   and c.contato_trava_humano is distinct from (ct.force_human or ct.is_blocked);

-- Os dois gatilhos que mantêm o bit. Definers porque escrevem sob RLS (o
-- atendente atualiza contato com o client de sessão; a ingestão, com o de
-- serviço), e as quatro origens de EXECUTE são revogadas como manda a doutrina
-- de definer nova em public — gatilho não passa por checagem de EXECUTE ao
-- disparar, então ninguém precisa dela.
create or replace function public.fn_conversa_calcula_trava_do_contato()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  new.contato_trava_humano := coalesce(
    (select (ct.force_human or ct.is_blocked)
       from public.contacts ct
      where ct.id = new.contact_id and ct.organization_id = new.organization_id),
    false);
  return new;
end;
$fn$;

revoke execute on function public.fn_conversa_calcula_trava_do_contato()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_conversa_calcula_trava_do_contato on public.conversations;
create trigger trg_conversa_calcula_trava_do_contato
  before insert or update of contact_id, organization_id, contato_trava_humano on public.conversations
  for each row execute function public.fn_conversa_calcula_trava_do_contato();

create or replace function public.fn_contato_atualiza_trava_nas_conversas()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.conversations
     set contato_trava_humano = (new.force_human or new.is_blocked)
   where contact_id = new.id
     and organization_id = new.organization_id;
  return new;
end;
$fn$;

revoke execute on function public.fn_contato_atualiza_trava_nas_conversas()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_contato_atualiza_trava_nas_conversas on public.contacts;
create trigger trg_contato_atualiza_trava_nas_conversas
  after update of force_human, is_blocked on public.contacts
  for each row execute function public.fn_contato_atualiza_trava_nas_conversas();

-- O índice do gatilho do contato: o unique de 1:1 começa por organization_id,
-- então não atende `where contact_id = ...`.
create index if not exists conversations_contact_id_idx
  on public.conversations (contact_id);

-- O campo calculado: mesma assinatura, mesmo definer, parâmetro sem nome — o
-- corpo é que deixa de resolver o contato por linha. A regra desta edição
-- mantém os seis argumentos existentes e o tratamento personalizado de grupos.
drop function if exists public.comando_da_conversa(public.conversations);

create function public.comando_da_conversa(public.conversations)
returns text
language sql
stable
security definer
set search_path = public
as $comando$
  select public.fn_comando_da_conversa(
    $1.status,
    $1.assigned_to_user_id,
    $1.bot_silenced_until,
    -- O bit consolida `force_human OR is_blocked`; entra no primeiro parâmetro
    -- de trava e o segundo vai `false` — o OR da regra é comutativo, e o
    -- resultado é o mesmo do wrapper antigo, sem a subconsulta por linha.
    $1.contato_trava_humano,
    false,
    now()
  );
$comando$;

comment on function public.comando_da_conversa(public.conversations)
  is 'Campo calculado exposto pelo PostgREST: ?select=comando_da_conversa e ?comando_da_conversa=in.(...). A trava do contato vem da COLUNA contato_trava_humano (issue #2739), não de subconsulta por linha; o prazo do silêncio é avaliado NA CONSULTA com now() de verdade. SECURITY DEFINER e parâmetro SEM NOME desde a 0404 (issue #1571). A regra em si é fn_comando_da_conversa.';

revoke execute on function public.comando_da_conversa(public.conversations) from public, anon;
grant execute on function public.comando_da_conversa(public.conversations) to authenticated, service_role;

notify pgrst, 'reload schema';
