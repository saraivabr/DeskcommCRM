"use client";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import Link from "next/link";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { randomId } from "@/lib/random-id";
import type { StudioItem } from "@/lib/instagram/schema";
import type { Publication } from "@/lib/instagram/publication-schema";
import { Notice, studioApi } from "./_shared";
type State = {
  accounts: {
    id: string;
    username: string;
    active: boolean;
    provider?: Publication["provider"];
    meta_asset_id?: string;
    connection_id?: string;
    story_eligible?: boolean;
  }[];
  publications: Publication[];
  can_publish: boolean;
  provider_errors?: { native: string | null; legacy: string | null };
};
const labels: Record<Publication["status"], string> = {
  preparing: "Preparando imagens",
  sending: "Confirmando envio",
  pending: "Processando no Instagram",
  published: "Publicado",
  failed: "Falhou",
  uncertain: "Aguardando confirmação",
};
function destinationKey(account: State["accounts"][number]) {
  return account.provider === "meta"
    ? `meta:${account.connection_id ?? ""}:${account.id}`
    : `legacy:${account.id}`;
}
export function PublishPost({
  item,
  caption,
  carouselItems,
}: {
  item: StudioItem;
  caption: string;
  carouselItems?: StudioItem[];
}) {
  const t = useT();
  const [state, setState] = useState<State>();
  const [account, setAccount] = useState("");
  const [library, setLibrary] = useState<StudioItem[]>([]);
  const [selected, setSelected] = useState<string[]>(
    carouselItems?.map((entry) => entry.id) ?? [item.id],
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const intent = useRef<{ fingerprint: string; id: string } | null>(null);
  const story = item.input.kind === "post" && item.input.format === "story";
  async function load() {
    const value = await studioApi<State>("/publish");
    setState(value);
    setAccount((current) =>
      value.accounts.some((a) => a.active && destinationKey(a) === current) ? current : "",
    );
  }
  useEffect(() => {
    void studioApi<State>("/publish")
      .then((value) => {
        setState(value);
      })
      .catch((e) => setError(e.message));
  }, []);
  const publications = state?.publications.filter((p) => p.item_ids.includes(item.id)) ?? [];
  const unresolved = publications.some((p) =>
    ["sending", "uncertain", "pending", "preparing"].includes(p.status),
  );
  const processing = publications.some((p) =>
    ["sending", "pending", "preparing"].includes(p.status),
  );
  const destination = state?.accounts.find((a) => destinationKey(a) === account && a.active);
  const destinationReady =
    !!destination &&
    (destination.provider !== "meta" ||
      (!!destination.meta_asset_id && !!destination.connection_id));
  const storyUnavailable =
    story && destination?.provider === "meta" && destination.story_eligible !== true;
  useEffect(() => {
    if (!processing) return;
    let alive = true;
    let checking = false;
    let attempts = 0;
    const interval = setInterval(() => {
      if (checking) return;
      if (++attempts > 24) {
        clearInterval(interval);
        return;
      }
      checking = true;
      void studioApi<State>("/publish")
        .then((value) => {
          if (alive) setState(value);
        })
        .catch(() => {
          if (alive)
            setError(
              t("Não foi possível atualizar o resultado. Atualize novamente antes de publicar."),
            );
        })
        .finally(() => {
          checking = false;
        });
    }, 5000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [processing, t]);
  async function publish() {
    if (!destinationReady || storyUnavailable || unresolved) {
      setError(t("Confira a conexão e o resultado anterior antes de publicar."));
      return;
    }
    setBusy(true);
    setError("");
    const body = {
      ...(destination?.provider === "meta"
        ? {
            provider: "meta",
            meta_asset_id: destination.meta_asset_id,
            connection_id: destination.connection_id,
          }
        : { account_id: destination?.id }),
      item_ids: selected,
      format: story ? "story" : selected.length > 1 ? "carousel" : "feed",
      caption,
    };
    const fingerprint = JSON.stringify(body);
    if (intent.current?.fingerprint !== fingerprint)
      intent.current = { fingerprint, id: randomId() };
    try {
      await studioApi("/publish", {
        method: "POST",
        body: JSON.stringify({ ...body, id: intent.current.id }),
      });
      setReviewing(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível publicar.");
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-4 rounded-2xl border p-5">
      <h2 className="font-semibold">{t("Publicar no Instagram")}</h2>
      <Link href="/app/connections?aba=sociais" className="text-sm underline">
        {t("Conectar ou trocar minha conta")}
      </Link>
      {error && <Notice error>{error}</Notice>}
      {state?.provider_errors?.native && (
        <Notice error>
          {t("Conexão Meta")}: {state.provider_errors.native}
        </Notice>
      )}
      {state?.provider_errors?.legacy && (
        <Notice error>
          {t("Conexão existente")}: {state.provider_errors.legacy}
        </Notice>
      )}
      {state && (
        <>
          <label className="block space-y-2">
            <span className="text-sm">{t("Conta que vai publicar")}</span>
            <select
              className="w-full rounded-xl border bg-background p-3"
              disabled={busy || reviewing}
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            >
              <option value="">{t("Selecione sua conta")}</option>
              {state.accounts
                .filter((a) => a.active)
                .map((a) => (
                  <option key={destinationKey(a)} value={destinationKey(a)}>
                    @{a.username} ·{" "}
                    {a.provider === "meta" ? t("Conexão Meta") : t("Conexão existente")}
                  </option>
                ))}
            </select>
          </label>
          {!story && !carouselItems && (
            <details
              onToggle={(e) => {
                if (e.currentTarget.open && !library.length)
                  void studioApi<{ items: StudioItem[] }>("")
                    .then((r) =>
                      setLibrary(
                        r.items.filter(
                          (i) =>
                            i.kind === "post" &&
                            i.status === "ready" &&
                            i.input.kind === "post" &&
                            i.input.format !== "story",
                        ),
                      ),
                    )
                    .catch((e) => setError(e.message));
              }}
            >
              <summary className="cursor-pointer text-sm underline">
                {t("Montar carrossel com minhas criações")}
              </summary>
              <p className="my-3 text-sm text-muted-foreground">
                {t("Selecione até 10 imagens. A ordem de seleção será a ordem do carrossel.")}
              </p>
              <div className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto">
                {library.map((i) => (
                  <label key={i.id} className="space-y-1 rounded-lg border p-2">
                    <input
                      type="checkbox"
                      disabled={
                        busy ||
                        reviewing ||
                        i.id === item.id ||
                        (!selected.includes(i.id) && selected.length >= 10)
                      }
                      checked={selected.includes(i.id)}
                      onChange={(e) =>
                        setSelected((s) =>
                          e.target.checked ? [...s, i.id] : s.filter((id) => id !== i.id),
                        )
                      }
                    />
                    <span className="ml-2 text-xs">
                      {selected.includes(i.id)
                        ? `${selected.indexOf(i.id) + 1}ª imagem`
                        : "Adicionar"}
                    </span>
                    {i.image_url && (
                      <Image
                        unoptimized
                        src={i.image_url}
                        alt={i.input.kind === "post" ? i.input.brief : "Criação"}
                        width={120}
                        height={150}
                        className="aspect-[4/5] w-full rounded-md object-cover"
                      />
                    )}
                  </label>
                ))}
              </div>
              <Link href="/app/instagram/new" className="mt-3 inline-block text-sm underline">
                {t("Gerar outra imagem para o carrossel")}
              </Link>
            </details>
          )}
          {story && (
            <p className="text-sm text-muted-foreground">
              {t("Stories ficam disponíveis por 24 horas e não exibem a legenda.")}
            </p>
          )}
          {storyUnavailable && (
            <Notice>
              {t(
                "Esta conexão ainda não confirmou a permissão para Stories. Publique uma imagem ou um carrossel.",
              )}
            </Notice>
          )}
          {reviewing ? (
            <div className="space-y-3 rounded-xl bg-muted/40 p-4">
              <p>
                {t("Publicar agora")}{" "}
                {selected.length > 1
                  ? `um carrossel com ${selected.length} imagens`
                  : story
                    ? t("este Story")
                    : t("esta imagem")}{" "}
                {t("em")} <strong>@{destination?.username}</strong>?
              </p>
              {!story && (
                <p className="text-sm whitespace-pre-wrap">{caption || t("Sem legenda")}</p>
              )}
              <p className="text-xs text-muted-foreground">
                {t("O conteúdo ficará visível na conta escolhida.")}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy || unresolved || !destinationReady || storyUnavailable}
                  onClick={() => void publish()}
                >
                  {busy ? t("Publicando…") : t("Confirmar publicação")}
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setReviewing(false)}>
                  {t("Voltar à revisão")}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              disabled={
                !state.can_publish ||
                !destinationReady ||
                storyUnavailable ||
                busy ||
                item.status !== "ready" ||
                unresolved
              }
              onClick={() => setReviewing(true)}
            >
              {t("Revisar publicação")}
            </Button>
          )}
          {publications.map((p) => (
            <div key={p.id} className="space-y-2 border-t pt-3 text-sm">
              <p className="font-medium">{t(labels[p.status])}</p>
              {p.error && <p role="status">{p.error}</p>}
              {p.status === "failed" && state.can_publish && (
                <Button
                  variant="outline"
                  disabled={busy || unresolved}
                  onClick={() => {
                    const previousDestination = state.accounts.find(
                      (a) =>
                        a.active &&
                        (p.provider === "meta"
                          ? a.provider === "meta" &&
                            a.meta_asset_id === p.meta_asset_id &&
                            a.connection_id === p.connection_id
                          : a.provider !== "meta" && a.id === p.account_id),
                    );
                    if (!previousDestination) {
                      setError(t("Reconecte a conta original antes de revisar esta tentativa."));
                      return;
                    }
                    setAccount(destinationKey(previousDestination));
                    setSelected(p.item_ids);
                    intent.current = null;
                    setReviewing(true);
                  }}
                >
                  {t("Revisar nova tentativa")}
                </Button>
              )}
              {p.permalink && (
                <a href={p.permalink} rel="noreferrer" target="_blank" className="underline">
                  {t("Ver no Instagram")}
                </a>
              )}
              {p.status === "published" && (
                <Link href="/app/growth/instagram" className="block underline">
                  {t("Criar automação para esta postagem")}
                </Link>
              )}
            </div>
          ))}
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void (async () => {
                setBusy(true);
                try {
                  await load();
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Não foi possível atualizar.");
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            {t("Atualizar resultado")}
          </Button>
        </>
      )}
    </section>
  );
}
