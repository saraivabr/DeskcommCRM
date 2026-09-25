import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { summarizeWhatsappHistory } from "@/lib/ai/whatsapp-history-panorama";
import { HistoryRefresh } from "./_refresh";
import { traduzir } from "@/lib/i18n/dicionario";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

export const dynamic = "force-dynamic";

type Search = Promise<{ q?: string; contact?: string }>;
type Contact = { id: string; name: string | null; display_name: string | null; phone_number: string | null };
type Message = { id: string; direction: string; body: string; sent_at: string };
type Sync = { status: string; chats_imported: number; messages_imported: number; error_code: string | null };

export default async function WhatsappHistoryPage({ searchParams }: { searchParams: Search }) {
  const user = await requireAuth();
  const t = (text: string) => traduzir(text, user.idioma);
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[org.role] < ROLE_RANK.manager) redirect("/403");
  const { q: rawQuery = "", contact: selected = "" } = await searchParams;
  const q = rawQuery.trim().slice(0, 80);
  const supabase = await createClient();
  const { data: syncData } = await supabase.from("whatsapp_history_syncs" as never)
    .select("status,chats_imported,messages_imported,error_code").eq("organization_id", org.orgId);
  const syncs = (syncData ?? []) as Sync[];

  let contacts: Contact[] = [];
  if (q.length >= 2) {
    const [byName, byDisplay, byPhone] = await Promise.all([
      supabase.from("contacts").select("id,name,display_name,phone_number").eq("organization_id", org.orgId).ilike("name", `%${q}%`).limit(30),
      supabase.from("contacts").select("id,name,display_name,phone_number").eq("organization_id", org.orgId).ilike("display_name", `%${q}%`).limit(30),
      supabase.from("contacts").select("id,name,display_name,phone_number").eq("organization_id", org.orgId).ilike("phone_number", `%${q}%`).limit(30),
    ]);
    contacts = [...new Map([...byName.data ?? [], ...byDisplay.data ?? [], ...byPhone.data ?? []]
      .map((c) => [c.id, c as Contact])).values()].slice(0, 30);
    if (contacts.length) {
      const { data: existing } = await supabase.from("whatsapp_history_contact_overview" as never)
        .select("contact_id").eq("organization_id", org.orgId).in("contact_id", contacts.map((c) => c.id));
      const withHistory = new Set(((existing ?? []) as Array<{ contact_id: string }>).map((r) => r.contact_id));
      contacts = contacts.filter((c) => withHistory.has(c.id));
    }
  } else {
    const { data: recent } = await supabase.from("whatsapp_history_contact_overview" as never)
      .select("contact_id").eq("organization_id", org.orgId).order("last_sent_at", { ascending: false }).limit(30);
    const ids = ((recent ?? []) as Array<{ contact_id: string }>).map((r) => r.contact_id);
    if (ids.length) {
      const { data } = await supabase.from("contacts").select("id,name,display_name,phone_number")
        .eq("organization_id", org.orgId).in("id", ids);
      contacts = (data ?? []) as Contact[];
    }
  }

  let chosen: Contact | null = null;
  let messages: Message[] = [];
  if (/^[0-9a-f-]{36}$/i.test(selected)) {
    const { data: person } = await supabase.from("contacts")
      .select("id,name,display_name,phone_number").eq("organization_id", org.orgId).eq("id", selected).maybeSingle();
    if (person) {
      chosen = person as Contact;
      const { data } = await supabase.from("whatsapp_history_messages" as never)
        .select("id,direction,body,sent_at").eq("organization_id", org.orgId)
        .eq("contact_id", selected).order("sent_at", { ascending: false }).limit(100);
      messages = ((data ?? []) as Message[]).reverse();
    }
  }
  const { data: sample } = await supabase.from("whatsapp_history_messages" as never)
    .select("direction,body").eq("organization_id", org.orgId)
    .order("sent_at", { ascending: false }).limit(500);
  const panorama = summarizeWhatsappHistory((sample ?? []) as Array<{ direction: string; body: string }>);
  const totalChats = syncs.reduce((n, s) => n + s.chats_imported, 0);
  const totalMessages = syncs.reduce((n, s) => n + s.messages_imported, 0);

  return <div className="space-y-6 p-6">
    <HistoryRefresh active={syncs.length === 0 || syncs.some((s) => s.status === "running" || s.status === "pending" || s.status === "failed")} />
    <div><Link href="/app/ai/knowledge/sources" className="text-sm text-primary underline">← {t("Conhecimento")}</Link>
      <h1 className="mt-2 text-2xl font-semibold">{t("Histórico do WhatsApp")}</h1>
      <p className="text-sm text-text-muted">{t("Conversas anteriores importadas ao conectar. O agente recebe o contexto do próprio contato no atendimento.")}</p>
    </div>
    <section className="rounded-lg border border-border p-4" aria-label={t("Progresso da importação")}>
      <h2 className="font-medium">{t("Importação")}</h2>
      <p className="text-sm text-text-muted">{totalChats} {t("conversas")} · {totalMessages} {t("mensagens de texto importadas")}</p>
      {syncs.length === 0 && <p className="text-sm">{t("Aguardando uma conexão WhatsApp compatível.")}</p>}
      {syncs.some((s) => s.status === "running" || s.status === "pending") && <p className="text-sm">{t("Importando em segundo plano…")}</p>}
      {syncs.some((s) => s.status === "unsupported") && <p className="text-sm">{t("Esta conexão foi pareada sem armazenamento de histórico. Uma nova conexão com sincronização habilitada é necessária.")}</p>}
      {syncs.some((s) => s.status === "failed") && <p className="text-sm text-destructive">{t("A importação encontrou uma falha e será tentada novamente.")}</p>}
    </section>
    <section className="rounded-lg border border-border p-4" aria-label={t("Panorama do negócio")}>
      <h2 className="font-medium">{t("Panorama das conversas")}</h2>
      <p className="text-sm text-text-muted">{t("Amostra das últimas")} {panorama.inbound + panorama.outbound} {t("mensagens de texto importadas")}: {panorama.inbound} {t("de clientes")} · {panorama.outbound} {t("da empresa")}.</p>
      {panorama.questions.length ? <><h3 className="mt-3 text-sm font-medium">{t("Perguntas que se repetem")}</h3>
        <ul className="mt-2 space-y-1 text-sm">{panorama.questions.map((item) => <li key={item.question}>{item.question} <span className="text-text-muted">({item.count} {t("vezes")})</span></li>)}</ul></>
        : <p className="mt-2 text-sm text-text-muted">{t("Ainda não há perguntas repetidas suficientes para mostrar um padrão confiável.")}</p>}
      <p className="mt-3 text-xs text-text-muted">{t("Padrões descritivos, não regras aprovadas. Para torná-los orientação geral dos agentes, registre a regra na")} <Link href="/app/ai/memory" className="underline">{t("Memória da IA")}</Link>.</p>
    </section>
    <section className="grid gap-4 md:grid-cols-[18rem_1fr]">
      <div className="space-y-3"><h2 className="font-medium">{t("Por contato")}</h2>
        <form action="/app/ai/knowledge/whatsapp-history"><label htmlFor="history-search" className="block text-sm">{t("Buscar nome ou telefone")}</label>
          <div className="flex gap-2"><input id="history-search" name="q" defaultValue={q} className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1" />
            <button className="rounded-md border border-border px-3 py-1 text-sm">{t("Buscar")}</button></div></form>
        <ul className="space-y-1">{contacts.map((c) => <li key={c.id}><Link className="block rounded-md border border-border p-2 text-sm hover:bg-muted" href={`?${new URLSearchParams({ q, contact: c.id })}`}>
          {c.display_name || c.name || c.phone_number || t("Contato sem nome")}</Link></li>)}</ul>
      </div>
      <div className="rounded-lg border border-border p-4"><h2 className="font-medium">{chosen ? chosen.display_name || chosen.name || chosen.phone_number || t("Contato") : t("Selecione um contato")}</h2>
        {chosen && messages.length === 0 && <p className="text-sm text-text-muted">{t("Nenhuma mensagem histórica deste contato.")}</p>}
        <ol className="mt-3 space-y-2">{messages.map((m) => <li key={m.id} className="rounded-md bg-muted p-2 text-sm">
          <span className="font-medium">{m.direction === "inbound" ? t("Cliente") : t("Empresa")}</span> · <time className="text-text-muted" dateTime={m.sent_at}>{new Date(m.sent_at).toLocaleString(user.idioma, { timeZone: fusoUtilizavel(user.timezone, org.timezone) })}</time>
          <p className="whitespace-pre-wrap break-words">{m.body}</p></li>)}</ol>
        {messages.length === 100 && <p className="mt-2 text-xs text-text-muted">{t("Exibindo as 100 mensagens mais recentes.")}</p>}
      </div>
    </section>
  </div>;
}
