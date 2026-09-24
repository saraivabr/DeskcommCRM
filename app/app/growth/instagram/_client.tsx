"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type {
  InstagramAutomation,
  InstagramPost,
  InstagramAutomationLog,
} from "@/lib/channels/social/instagram-management";
import { randomId } from "@/lib/random-id";

type State = {
  automations: InstagramAutomation[];
  accounts: { id: string; username: string; active: boolean }[];
  can_edit: boolean;
};
async function api<T>(query = "", body?: unknown): Promise<T> {
  const response = await fetch(
    `/api/v1/growth/instagram${query}`,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : { cache: "no-store" },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error?.message ?? "Não foi possível concluir. Tente novamente.");
  return result.data;
}
const field = "w-full rounded-xl border bg-background p-3";
export function InstagramGrowthClient({ orgId: _orgId }: { orgId: string }) {
  const [state, setState] = useState<State>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<InstagramAutomation | "new" | null>(null);
  const [requestId, setRequestId] = useState("");
  const [account, setAccount] = useState("");
  const [posts, setPosts] = useState<InstagramPost[]>([]);
  const [post, setPost] = useState("");
  const [name, setName] = useState("");
  const [keywords, setKeywords] = useState("");
  const [mode, setMode] = useState("word");
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState("");
  const [logs, setLogs] = useState<{ name: string; rows: InstagramAutomationLog[] } | null>(null);
  async function load() {
    setState(await api<State>());
  }
  useEffect(() => {
    void api<State>()
      .then(setState)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!account || !editing) return;
    let active = true;
    void api<{ posts: InstagramPost[] }>(`?account_id=${account}`)
      .then((r) => {
        if (active) setPosts(r.posts);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [account, editing]);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível concluir.");
    } finally {
      setBusy(false);
    }
  }
  function edit(rule: InstagramAutomation | "new") {
    setEditing(rule);
    setRequestId(randomId());
    setError("");
    const r = rule === "new" ? null : rule;
    setAccount(r?.accountId ?? state?.accounts.find((a) => a.active)?.id ?? "");
    setPost(r?.platformPostId ?? "");
    setName(r?.name ?? "");
    setKeywords(r?.keywords.join(", ") ?? "");
    setMode(r?.matchMode ?? "word");
    setMessage(r?.dmMessage ?? "");
    setReply(r?.commentReply ?? "");
  }
  return (
    <main className="mx-auto w-full max-w-5xl space-y-7 p-5 sm:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Instagram</p>
          <h1 className="text-3xl font-semibold">Transforme comentários em conversas.</h1>
          <p className="mt-3 max-w-xl text-muted-foreground">
            Escolha uma postagem e as palavras que enviam sua resposta no Direct.
          </p>
        </div>
        <Link href="/app/connections?aba=sociais" className="text-sm underline">
          Conectar Instagram
        </Link>
      </header>
      {error && (
        <p role="alert" className="rounded-xl border border-destructive p-4 text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={!state?.can_edit || busy || !state.accounts.some((a) => a.active)}
          onClick={() => edit("new")}
        >
          Nova automação
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void run(load)}>
          Atualizar resultados
        </Button>
      </div>
      {!state && !error && <p role="status">Carregando suas automações…</p>}
      {state && (
        <div className="grid grid-cols-3 gap-3">
          {[
            ["Ativas", state.automations.filter((a) => a.isActive).length],
            ["Directs enviados", state.automations.reduce((n, a) => n + a.stats.dmsSent, 0)],
            ["Falhas", state.automations.reduce((n, a) => n + a.stats.dmsFailed, 0)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-2xl border p-4">
              <p className="text-sm text-muted-foreground">{label}</p>
              <p className="mt-2 text-2xl font-semibold">{value}</p>
            </div>
          ))}
        </div>
      )}
      {state?.automations.length === 0 && (
        <p className="rounded-2xl border p-8">
          Nenhuma automação ainda. Conecte uma conta e escolha sua primeira postagem.
        </p>
      )}
      <div className="space-y-4">
        {state?.automations.map((rule) => (
          <article key={rule.id} className="space-y-3 rounded-2xl border p-5">
            <div className="flex flex-wrap justify-between gap-3">
              <h2 className="font-semibold">{rule.name}</h2>
              <span className="text-sm">{rule.isActive ? "Ativa" : "Pausada"}</span>
            </div>
            <p className="text-sm text-muted-foreground">
              {rule.postTitle ||
                (rule.platformPostId ? `Postagem ${rule.platformPostId}` : "Todas as postagens")}
            </p>
            <p className="text-sm">Palavras: {rule.keywords.join(", ") || "Qualquer comentário"}</p>
            <p className="rounded-xl bg-muted/40 p-3 text-sm whitespace-pre-wrap">
              {rule.dmMessage}
            </p>
            <p className="text-sm text-muted-foreground">
              {rule.stats.dmsSent} enviados · {rule.stats.dmsFailed} falhas · {rule.stats.read}{" "}
              lidos
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const r = await api<{ logs: InstagramAutomationLog[] }>(`?logs=${rule.id}`);
                    setLogs({ name: rule.name, rows: r.logs });
                  })
                }
              >
                Ver resultados
              </Button>
              {state.can_edit && (
                <>
                  <Button variant="outline" disabled={busy} onClick={() => edit(rule)}>
                    Editar
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api("", { action: "toggle", id: rule.id, is_active: !rule.isActive });
                        await load();
                      })
                    }
                  >
                    {rule.isActive ? "Pausar" : "Ativar"}
                  </Button>
                </>
              )}
            </div>
          </article>
        ))}
      </div>
      {logs && (
        <section className="space-y-3 rounded-2xl border p-5">
          <div className="flex justify-between gap-3">
            <h2 className="font-semibold">Resultados · {logs.name}</h2>
            <Button variant="ghost" onClick={() => setLogs(null)}>
              Fechar
            </Button>
          </div>
          {logs.rows.length === 0 && <p>Nenhuma execução registrada.</p>}
          {logs.rows.map((log) => (
            <div key={log.id} className="space-y-1 border-t py-3 text-sm">
              <p>
                {new Date(log.createdAt).toLocaleString("pt-BR")} ·{" "}
                {(
                  {
                    sent: "Enviado",
                    failed: "Falhou",
                    pending: "Aguardando envio",
                    skipped: "Ignorado",
                    gated: "Aguardando confirmação",
                  } as Record<string, string>
                )[log.status] ?? log.status}
              </p>
              <p>{log.commentText}</p>
              {log.error && <p className="text-destructive">{log.error}</p>}
              {log.commentReplyError && (
                <p className="text-destructive">Resposta pública: {log.commentReplyError}</p>
              )}
            </div>
          ))}
        </section>
      )}
      {editing && (
        <section className="rounded-2xl border bg-card p-5 sm:p-7" aria-label="Editor de automação">
          <h2 className="mb-5 text-xl font-semibold">
            {editing === "new" ? "Nova automação" : "Editar automação"}
          </h2>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api("", {
                  action: editing === "new" ? "create" : "edit",
                  id: editing === "new" ? requestId : editing.id,
                  rule: {
                    name,
                    account_id: account,
                    post_id: post,
                    keywords: keywords
                      .split(",")
                      .map((k) => k.trim())
                      .filter(Boolean),
                    match_mode: mode,
                    dm_response_template: message,
                    comment_reply: reply,
                  },
                });
                setEditing(null);
                await load();
              });
            }}
          >
            <label className="block space-y-2">
              <span>Nome da automação</span>
              <Input
                required
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="block space-y-2">
              <span>Conta do Instagram</span>
              <select
                className={field}
                value={account}
                disabled={editing !== "new"}
                onChange={(e) => {
                  setPosts([]);
                  setAccount(e.target.value);
                  setPost("");
                }}
              >
                {state?.accounts
                  .filter((a) => a.active)
                  .map((a) => (
                    <option value={a.id} key={a.id}>
                      @{a.username}
                    </option>
                  ))}
              </select>
            </label>
            <label className="block space-y-2">
              <span>Postagem que receberá os comentários</span>
              <select
                required
                className={field}
                disabled={editing !== "new"}
                value={post}
                onChange={(e) => setPost(e.target.value)}
              >
                <option value="">
                  {editing === "new" ? "Escolha uma postagem" : "Todas as postagens"}
                </option>
                {post && !posts.some((p) => p.id === post) && (
                  <option value={post}>Postagem {post}</option>
                )}
                {posts.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.message.slice(0, 110) || p.id}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-2">
              <span>Palavras-chave, separadas por vírgula</span>
              <Input
                required
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder="QUERO, PREÇO"
              />
            </label>
            <label className="block space-y-2">
              <span>Quando responder</span>
              <select className={field} value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="word">A palavra aparece no comentário</option>
                <option value="contains">O comentário contém o texto</option>
                <option value="exact">O comentário é exatamente o texto</option>
              </select>
            </label>
            <label className="block space-y-2">
              <span id="instagram-dm-label">Mensagem no Direct</span>
              <Textarea
                aria-labelledby="instagram-dm-label"
                required
                maxLength={640}
                rows={5}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </label>
            <label className="block space-y-2">
              <span id="instagram-reply-label">Resposta pública após o Direct (opcional)</span>
              <Textarea
                aria-labelledby="instagram-reply-label"
                maxLength={1000}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="Te enviei os detalhes no Direct."
              />
            </label>
            <p className="text-sm text-muted-foreground">
              Ao salvar uma nova regra, ela fica ativa. O envio depende das permissões e limites do
              Instagram; acompanhe recusas em Ver resultados.
            </p>
            <div className="flex gap-3">
              <Button disabled={busy} type="submit">
                {busy ? "Salvando…" : editing === "new" ? "Salvar e ativar" : "Salvar alterações"}
              </Button>
              <Button
                disabled={busy}
                variant="outline"
                type="button"
                onClick={() => setEditing(null)}
              >
                Cancelar
              </Button>
            </div>
          </form>
        </section>
      )}
    </main>
  );
}
