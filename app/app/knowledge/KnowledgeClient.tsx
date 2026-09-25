"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KnowledgePage, PageInput } from "@/lib/knowledge/schema";
const Editor = dynamic(() => import("./BlockEditor"), {
  ssr: false,
  loading: () => <p>Carregando editor…</p>,
});
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/knowledge${path}`, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "Não foi possível concluir.");
  return body.data as T;
}
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
type PageSummary = Pick<
  KnowledgePage,
  "id" | "title" | "parent_id" | "revision" | "indexed_revision"
>;
export function KnowledgeClient({ canEdit }: { canEdit: boolean }) {
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [page, setPage] = useState<KnowledgePage | null>(null);
  const [trash, setTrash] = useState(false);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; title: string; excerpt: string }[] | null>(
    null,
  );
  const [history, setHistory] = useState<KnowledgePage[]>([]);
  const [editorKey, setEditorKey] = useState(0);
  const current = useRef<KnowledgePage | null>(null);
  const selection = useRef(0);
  const dirty = useRef(false);
  const saving = useRef(false);
  const pending = useRef<PageInput | null>(null);
  const pendingGeneration = useRef(0);
  const generation = useRef(0);
  const halted = useRef(false);
  const [saveHalted, setSaveHalted] = useState(false);
  const reload = useCallback(async () => {
    setPages(await api<PageSummary[]>(`?archived=${trash}`));
  }, [trash]);
  useEffect(() => {
    void reload().catch((e) => setError(e.message));
  }, [reload]);
  useEffect(() => {
    void api<{ page_id: string }[]>("/favorites")
      .then((rows) => setFavorites(rows.map((r) => r.page_id)))
      .catch((e) => setError(e.message));
  }, []);
  const save = useCallback(async () => {
    const p = current.current;
    if (!p || !dirty.current || saving.current || halted.current) return;
    saving.current = true;
    setStatus("Salvando…");
    const version = pending.current ? pendingGeneration.current : generation.current;
    const input = pending.current ?? {
      id: p.id,
      title: p.title || "Sem título",
      markdown: p.markdown,
      parent_id: p.parent_id,
      archived: p.archived,
      expected_revision: p.revision,
      operation_id: crypto.randomUUID(),
    };
    pending.current = input;
    pendingGeneration.current = version;
    try {
      const saved = await api<KnowledgePage>("", json(input));
      pending.current = null;
      const next =
        generation.current === version ? saved : { ...current.current!, revision: saved.revision };
      current.current = next;
      setPage(next);
      dirty.current = generation.current !== version;
      setStatus(dirty.current ? "Alterações pendentes" : "Salvo");
      setError("");
      await reload();
    } catch (e) {
      setError((e as Error).message);
      setStatus("Não salvo");
      halted.current = true;
      setSaveHalted(true);
    } finally {
      saving.current = false;
    }
  }, [reload]);
  useEffect(() => {
    const timer = setInterval(() => {
      void save();
    }, 1500);
    return () => clearInterval(timer);
  }, [save]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const navigate = (event: MouseEvent) => {
      if (!dirty.current || !(event.target instanceof Element)) return;
      const link = event.target.closest("a[href]");
      if (link && !window.confirm("Há alterações não salvas. Sair desta página e descartá-las?")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", navigate, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", navigate, true);
    };
  }, []);
  async function open(id: string) {
    await save();
    if (dirty.current) {
      setError("Salve ou copie suas alterações antes de trocar de página.");
      return;
    }
    const requestNumber = ++selection.current;
    try {
      const p = await api<KnowledgePage>(`/${id}`);
      if (requestNumber !== selection.current || dirty.current) return;
      current.current = p;
      setPage(p);
      setEditorKey((k) => k + 1);
      setHistory([]);
      setError("");
      setStatus("Salvo");
      window.history.replaceState(null, "", `?page=${id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("page");
    if (id) void open(id);
  }, []); // Initial deep link only.
  useEffect(() => {
    const timer = setInterval(() => {
      const id = current.current?.id;
      if (!id || dirty.current || saving.current) return;
      void api<KnowledgePage>(`/${id}`)
        .then((fresh) => {
          if (current.current?.id !== id || dirty.current || saving.current) return;
          if (fresh.revision !== current.current.revision) return;
          current.current = fresh;
          setPage(fresh);
        })
        .catch(() => {
          setError("Não foi possível atualizar o estado da indexação.");
        });
    }, 8000);
    return () => clearInterval(timer);
  }, []);
  function edit(values: Partial<KnowledgePage>) {
    if (!current.current || !canEdit || halted.current) return;
    current.current = { ...current.current, ...values };
    setPage(current.current);
    dirty.current = true;
    generation.current++;
    setStatus("Alterações pendentes");
  }
  async function create() {
    await save();
    if (dirty.current) return;
    const id = crypto.randomUUID();
    try {
      await api(
        "",
        json({
          id,
          title: "Sem título",
          markdown: "",
          parent_id: null,
          archived: false,
          expected_revision: 0,
          operation_id: crypto.randomUUID(),
        }),
      );
      await reload();
      await open(id);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function search() {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    try {
      const found = await api<{
        results: { id: string; title: string; excerpt: string }[];
        warning: string | null;
      }>(`/search?q=${encodeURIComponent(query)}`);
      setResults(found.results);
      setError(found.warning ?? "");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function importDocument(file?: File) {
    await save();
    if (dirty.current) return;
    const url = file ? null : window.prompt("Endereço HTTPS da página pública");
    if (!file && !url) return;
    setStatus("Importando…");
    try {
      const form = new FormData();
      if (file) form.append("file", file);
      const saved = await api<KnowledgePage>(
        "/import",
        file ? { method: "POST", body: form } : json({ url }),
      );
      await reload();
      await open(saved.id);
    } catch (e) {
      setError((e as Error).message);
      setStatus("Importação falhou");
    }
  }
  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside className="w-full space-y-3 border-r p-4 md:w-72 md:overflow-y-auto">
        <h1 className="text-xl font-semibold">Conhecimento</h1>
        <p className="text-sm text-muted-foreground">
          Ideias e informações da sua equipe, prontas para consultar.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
          className="flex gap-2"
        >
          <input
            aria-label="Pesquisar conhecimento"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 rounded border p-2"
            placeholder="Pesquisar…"
          />
          <button>Buscar</button>
        </form>
        {canEdit && (
          <div className="flex flex-wrap gap-3 text-sm">
            <button onClick={() => void create()}>+ Nova página</button>
            <button onClick={() => void importDocument()}>Importar URL</button>
            <label className="cursor-pointer">
              Importar PDF
              <input
                className="sr-only"
                type="file"
                accept="application/pdf"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importDocument(f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        )}
        <button
          className="text-sm underline"
          onClick={() => {
            setTrash(!trash);
            setResults(null);
          }}
        >
          {trash ? "Voltar às páginas" : "Lixeira"}
        </button>
        <nav className="space-y-1" aria-label="Páginas">
          {(
            results ??
            [...pages].sort(
              (a, b) => Number(favorites.includes(b.id)) - Number(favorites.includes(a.id)),
            )
          ).map((p) => (
            <button
              key={p.id}
              onClick={() => void open(p.id)}
              className={`block w-full rounded p-2 text-left ${page?.id === p.id ? "bg-muted" : "hover:bg-muted"}`}
            >
              {favorites.includes(p.id) ? "★ " : ""}
              {"parent_id" in p && p.parent_id ? "↳ " : ""}
              {p.title}
            </button>
          ))}
        </nav>
        {pages.length === 100 && (
          <button
            onClick={() =>
              void api<PageSummary[]>(`?archived=${trash}&offset=${pages.length}`)
                .then((more) => setPages([...pages, ...more]))
                .catch((e) => setError(e.message))
            }
          >
            Carregar mais
          </button>
        )}
      </aside>
      <main className="min-w-0 flex-1 space-y-4 overflow-y-auto p-6">
        <div role="status" className="text-sm text-muted-foreground">
          {status}
          {page &&
            ` · ${page.archived ? "Na lixeira" : page.indexed_revision === page.revision ? "Disponível para IA" : page.markdown.trim() ? (page.index_status === "indexando" ? "Indexando" : (page.index_error ?? "Indexação pendente")) : "Página vazia"}`}
        </div>
        {error && (
          <div role="alert" className="rounded border border-destructive p-3">
            {error}
            {saveHalted && (
              <button
                className="ml-3 underline"
                onClick={() => {
                  halted.current = false;
                  setSaveHalted(false);
                  void save();
                }}
              >
                Tentar salvar novamente
              </button>
            )}
          </div>
        )}
        {!page ? (
          <p>Crie uma página ou escolha uma ao lado.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-3 text-sm">
              <button
                onClick={async () => {
                  try {
                    const favorite = !favorites.includes(page.id);
                    await api("/favorites", json({ page_id: page.id, favorite }));
                    setFavorites(
                      favorite ? [...favorites, page.id] : favorites.filter((id) => id !== page.id),
                    );
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                {favorites.includes(page.id) ? "★ Favorita" : "☆ Favoritar"}
              </button>
              <button
                onClick={() =>
                  void api<KnowledgePage[]>(`/${page.id}/revisions`)
                    .then(setHistory)
                    .catch((e) => setError(e.message))
                }
              >
                Revisões
              </button>
              {canEdit && (
                <button
                  onClick={() => {
                    if (
                      page.archived ||
                      window.confirm(
                        "Mover esta página para a lixeira? Ela deixará de aparecer nas buscas.",
                      )
                    ) {
                      edit({ archived: !page.archived });
                      void save();
                    }
                  }}
                >
                  {page.archived ? "Restaurar" : "Mover para lixeira"}
                </button>
              )}
              <button
                onClick={() => {
                  const blob = new Blob([current.current?.markdown ?? ""], {
                    type: "text/markdown",
                  });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "pagina.md";
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Baixar Markdown
              </button>
            </div>
            <input
              aria-label="Título da página"
              className="w-full bg-transparent text-3xl font-semibold outline-none"
              value={page.title}
              maxLength={120}
              disabled={!canEdit || page.archived}
              onChange={(e) => edit({ title: e.target.value })}
            />
            {canEdit && !page.archived && (
              <select
                aria-label="Página superior"
                value={page.parent_id ?? ""}
                onChange={(e) => edit({ parent_id: e.target.value || null })}
              >
                <option value="">Página principal</option>
                {pages
                  .filter((p) => p.id !== page.id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                    </option>
                  ))}
              </select>
            )}
            <Editor
              key={`${page.id}:${editorKey}`}
              markdown={page.markdown}
              editable={canEdit && !page.archived && !saveHalted}
              onChange={(markdown) => edit({ markdown })}
            />
            {page.source_url && (
              <a
                className="text-sm underline"
                href={page.source_url}
                target="_blank"
                rel="noreferrer"
              >
                Ver fonte original
              </a>
            )}
            {history.length > 0 && (
              <section aria-label="Histórico">
                <h2 className="font-semibold">Revisões</h2>
                {history.map((r) => (
                  <div className="border-b py-2" key={r.revision}>
                    Revisão {r.revision} · {r.title}{" "}
                    {canEdit && (
                      <button
                        className="underline"
                        onClick={() => {
                          edit({ title: r.title, markdown: r.markdown });
                          setEditorKey((k) => k + 1);
                          void save();
                        }}
                      >
                        Restaurar conteúdo
                      </button>
                    )}
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
