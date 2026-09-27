"use client";
import { useT } from "@/hooks/i18n/useT";
import Link from "next/link";
import { copyToClipboard } from "@/lib/clipboard";
import Image from "next/image";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { StudioItem } from "@/lib/instagram/schema";
import { carouselTemplates } from "@/lib/instagram/carousel-templates";
import { StudioShell, Intro, Loading, Notice, studioApi } from "./_shared";
import { PublishPost } from "./_publish";
import { ImageGeneration } from "./_image-generation";
export function Review({ id }: { id: string }) {
  const t = useT();
  const [item, setItem] = useState<StudioItem | null>(null);
  const [carouselItems, setCarouselItems] = useState<StudioItem[]>([]);
  const [carouselLoading, setCarouselLoading] = useState(false);
  const [caption, setCaption] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const value = await studioApi<StudioItem>(`/${id}`);
        if (!active) return;
        setItem(value);
        setCaption(value.caption);
        if (value.input.kind === "post" && value.input.carousel) {
          const carouselId = value.input.carousel.id;
          setCarouselLoading(true);
          try {
            const listing = await studioApi<{ items: StudioItem[] }>(`?carousel_id=${carouselId}`);
            if (active)
              setCarouselItems(
                listing.items
                  .filter(
                    (entry) =>
                      entry.input.kind === "post" && entry.input.carousel?.id === carouselId,
                  )
                  .sort((a, b) =>
                    a.input.kind === "post" && b.input.kind === "post"
                      ? (a.input.carousel?.slide ?? 0) - (b.input.carousel?.slide ?? 0)
                      : 0,
                  ),
              );
          } catch (e) {
            if (active)
              setError(e instanceof Error ? e.message : "Não foi possível carregar o carrossel.");
          } finally {
            if (active) setCarouselLoading(false);
          }
        }
        if (value.status === "generating") timer = setTimeout(() => void read(), 5000);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Não foi possível abrir.");
      }
    };
    void read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [id]);
  async function save() {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await studioApi(`/${id}`, { method: "PATCH", body: JSON.stringify({ caption }) });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "A legenda não foi salva.");
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    if (!item?.image_url) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch(item.image_url);
      if (!r.ok)
        throw new Error("O link da imagem expirou. Atualize esta página e tente novamente.");
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `postagem-${id}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível baixar.");
    } finally {
      setBusy(false);
    }
  }
  const carouselTemplate = item?.input.kind === "post" ? item.input.carousel?.template : undefined;
  const carouselReady =
    carouselItems.length === 8 &&
    carouselItems.every((entry) => entry.status === "ready") &&
    new Set(
      carouselItems.map((entry) => (entry.input.kind === "post" ? entry.input.carousel?.slide : 0)),
    ).size === 8;
  return (
    <StudioShell>
      <Intro eyebrow={t("Revisar postagem")} title={t("Agora, deixe com a sua cara.")}>
        {t("Confira a imagem, ajuste a legenda e leve sua ideia para o Instagram.")}
      </Intro>
      {error && <Notice error>{error}</Notice>}
      {!item && !error ? (
        <Loading />
      ) : item && item.input.kind === "post" ? (
        <div className="grid gap-9 lg:grid-cols-2">
          <div className="flex min-h-72 items-center justify-center overflow-hidden rounded-3xl border border-border bg-muted/30">
            {item.image_url ? (
              <Image
                unoptimized
                width={1024}
                height={1280}
                src={item.image_url}
                alt={item.input.brief}
                className="max-h-[650px] w-full object-contain"
              />
            ) : item.status === "generating" && !error ? (
              <ImageGeneration format={item.input.format} />
            ) : (
              <Notice error={item.status === "failed"}>
                {item.error ||
                  (item.status === "generating"
                    ? t("Sua imagem está sendo criada. Você pode voltar pela biblioteca.")
                    : t(
                        "Não foi possível abrir a imagem. Atualize a página para renovar o acesso.",
                      ))}
              </Notice>
            )}
          </div>
          <div className="space-y-5">
            {item.input.carousel && (
              <section className="space-y-3 rounded-2xl border p-4">
                <h2 className="font-medium">
                  {t(carouselTemplates[item.input.carousel.template].label)}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {carouselLoading
                    ? t("Carregando slides…")
                    : `${carouselItems.filter((entry) => entry.status === "ready").length}/8 ${t("slides prontos para revisão")}`}
                </p>
                <div className="grid grid-cols-4 gap-2">
                  {carouselItems.map(
                    (entry) =>
                      entry.input.kind === "post" && (
                        <Link
                          href={`/app/instagram/posts/${entry.id}`}
                          key={entry.id}
                          className="space-y-1 rounded-lg border p-1"
                        >
                          {entry.image_url && (
                            <Image
                              unoptimized
                              src={entry.image_url}
                              alt={`${entry.input.carousel?.slide}º slide`}
                              width={160}
                              height={200}
                              className="aspect-[4/5] w-full rounded object-cover"
                            />
                          )}
                          <span className="block text-xs">
                            {entry.input.carousel?.slide}.{" "}
                            {carouselTemplate &&
                              carouselTemplates[carouselTemplate].slides[
                                (entry.input.carousel?.slide ?? 1) - 1
                              ]?.role}
                          </span>
                        </Link>
                      ),
                  )}
                </div>
                {carouselItems[0] && item.id !== carouselItems[0].id && (
                  <Link
                    href={`/app/instagram/posts/${carouselItems[0].id}`}
                    className="text-sm underline"
                  >
                    {t("Revisar carrossel completo")}
                  </Link>
                )}
                {!carouselLoading && !carouselReady && (
                  <Notice error>
                    {t(
                      "Este carrossel ainda não está completo. Revise os slides na biblioteca antes de publicar.",
                    )}
                  </Notice>
                )}
              </section>
            )}
            <div>
              <p className="text-sm text-muted-foreground">{t("Sua ideia")}</p>
              <p className="mt-2 whitespace-pre-wrap">{item.input.brief}</p>
            </div>
            <label htmlFor="caption" className="block font-medium">
              {t("Legenda da postagem")}
            </label>
            <Textarea
              id="caption"
              rows={9}
              maxLength={2200}
              value={caption}
              disabled={busy || !item.can_edit}
              onChange={(e) => {
                setCaption(e.target.value);
                setSaved(false);
              }}
              placeholder={t("Escreva o convite para quem vai ver sua postagem…")}
            />
            <p className="text-sm text-muted-foreground">
              {caption.length}
              {t("/2.200 caracteres")}
            </p>
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => void save()} disabled={busy || !item.can_edit}>
                {t("Salvar legenda")}
              </Button>
              <Button
                variant="outline"
                onClick={() => void download()}
                disabled={busy || !item.image_url}
              >
                {t("Baixar imagem")}
              </Button>
              <Button
                variant="ghost"
                disabled={!caption}
                onClick={() =>
                  void copyToClipboard(caption)
                    .then((ok) => {
                      if (ok) setCopied(true);
                      else
                        setError(
                          "Não foi possível copiar. Selecione a legenda e copie manualmente.",
                        );
                    })
                    .catch(() =>
                      setError("Não foi possível copiar. Selecione a legenda e copie manualmente."),
                    )
                }
              >
                {t("Copiar legenda")}
              </Button>
            </div>
            {item.status === "ready" &&
              (!item.input.carousel || (carouselReady && item.id === carouselItems[0]?.id)) && (
                <PublishPost
                  item={item}
                  caption={caption}
                  carouselItems={item.input.carousel ? carouselItems : undefined}
                />
              )}
            {saved && <Notice>{t("Legenda salva com sucesso.")}</Notice>}
            {copied && <Notice>{t("Legenda copiada.")}</Notice>}
            <Link
              className="block text-sm underline"
              href={`/app/instagram/new?brief=${encodeURIComponent(item.input.brief)}&niche=${encodeURIComponent(item.input.niche)}`}
            >
              {t("Criar outra versão")}
            </Link>
            <Link className="block text-sm underline" href="/app/instagram/library">
              {t("Voltar para minhas criações")}
            </Link>
            <p className="text-sm text-muted-foreground">
              {t("Baixar ou salvar não publica a postagem. Você escolhe quando compartilhar.")}
            </p>
          </div>
        </div>
      ) : null}
    </StudioShell>
  );
}
