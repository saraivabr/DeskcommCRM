"use client";
import { randomId } from "@/lib/random-id";
import { useT } from "@/hooks/i18n/useT";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import Image from "next/image";
import type { CompanyContext } from "@/lib/instagram/brand";
import { Textarea } from "@/components/ui/textarea";
import { formats, type StudioItem } from "@/lib/instagram/schema";
import { carouselTemplates, type CarouselTemplateId } from "@/lib/instagram/carousel-templates";
import { StudioShell, Intro, Notice, studioApi } from "./_shared";
import { ImageGeneration } from "./_image-generation";
export function CreatePost({
  company,
  firstPost = false,
  canViewBilling = false,
  initialBrief = "",
  initialNiche = "",
}: {
  company: CompanyContext;
  firstPost?: boolean;
  canViewBilling?: boolean;
  initialBrief?: string;
  initialNiche?: string;
}) {
  const t = useT();
  const router = useRouter();
  const pendingRequest = useRef<{
    fingerprint: string;
    ids: string[];
    group: string | null;
  } | null>(null);
  const [brief, setBrief] = useState(initialBrief);
  const [niche, setNiche] = useState(initialNiche);
  const [format, setFormat] = useState<keyof typeof formats>("feed");
  const [carouselTemplate, setCarouselTemplate] = useState<CarouselTemplateId | "">("");
  const [progress, setProgress] = useState(0);
  const [useLogo, setUseLogo] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const fingerprint = JSON.stringify({ brief, niche, format, useLogo, carouselTemplate });
    if (pendingRequest.current?.fingerprint !== fingerprint)
      pendingRequest.current = {
        fingerprint,
        ids: Array.from({ length: carouselTemplate ? 8 : 1 }, () => randomId()),
        group: carouselTemplate ? randomId() : null,
      };
    const request = pendingRequest.current;
    try {
      setProgress(0);
      let firstId = request.ids[0];
      for (let index = 0; index < request.ids.length; index++) {
        const item = await studioApi<StudioItem>("", {
          method: "POST",
          body: JSON.stringify({
            id: request.ids[index],
            kind: "post",
            brief,
            niche,
            format: carouselTemplate ? "feed" : format,
            use_logo: useLogo,
            caption: "",
            ...(carouselTemplate
              ? { carousel: { id: request.group, template: carouselTemplate, slide: index + 1 } }
              : {}),
          }),
        });
        if (item.status !== "ready")
          throw new Error("A criação precisa ser conferida na biblioteca antes de continuar.");
        if (index === 0) firstId = item.id;
        setProgress(index + 1);
      }
      router.push(`/app/instagram/posts/${firstId}`);
    } catch (e) {
      setError(
        `${e instanceof Error ? e.message : "Não foi possível gerar."}${carouselTemplate ? " Os slides concluídos estão na biblioteca; confira o estado do pedido antes de criar outro." : ""}`,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <StudioShell>
      <Intro
        eyebrow={t(firstPost ? "Sua primeira postagem" : "Criar postagem")}
        title={t("O que você quer contar?")}
      >
        {t("Uma ideia já é um começo. Descreva do seu jeito; a imagem e a legenda nascem daqui.")}
      </Intro>
      <form onSubmit={submit} className="grid items-start gap-10 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-6">
          <section className="rounded-3xl border border-border bg-muted/30 p-5">
            <div className="flex items-center gap-4">
              {company.logoUrl && (
                <Image
                  unoptimized
                  width={64}
                  height={64}
                  src={company.logoUrl}
                  alt={company.name}
                  className="h-16 w-16 rounded-xl bg-white object-contain p-2"
                />
              )}
              <div>
                <p className="text-sm text-muted-foreground">{t("Criando para")}</p>
                <h2 className="text-xl font-medium">{company.name}</h2>
              </div>
            </div>
            {niche && <p className="mt-3 line-clamp-3 text-sm text-muted-foreground">{niche}</p>}
            <details open={!initialNiche || undefined} className="mt-4">
              <summary className="cursor-pointer text-sm underline underline-offset-4">
                {t("Ajustar contexto da empresa")}
              </summary>
              <label htmlFor="niche" className="mt-4 mb-2 block text-sm font-medium">
                {t("O que sua empresa faz?")}
              </label>
              <Textarea
                id="niche"
                onInvalid={(e) => {
                  const section = e.currentTarget.closest("details");
                  if (section) section.open = true;
                }}
                required
                minLength={2}
                maxLength={2000}
                rows={4}
                value={niche}
                onChange={(e) => setNiche(e.target.value)}
                placeholder={t("Ex.: confeitaria artesanal")}
                disabled={busy}
              />
              <p className="mt-2 text-sm text-muted-foreground">
                {t("Esse contexto será reaproveitado nas próximas criações.")}
              </p>
              {company.descriptionSource === "agent" && (
                <p className="mt-2 text-sm text-muted-foreground">
                  {t("Contexto encontrado na descrição do seu agente. Você pode ajustar aqui.")}
                </p>
              )}
            </details>
            {company.logoUrl && (
              <label className="mt-4 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={useLogo}
                  onChange={(e) => setUseLogo(e.target.checked)}
                  disabled={busy}
                />
                {t("Usar meu logo como referência")}
              </label>
            )}
          </section>
          <div className="space-y-2">
            <label htmlFor="brief" className="block font-medium">
              {t("Conte sua ideia")}
            </label>
            <Textarea
              id="brief"
              required
              minLength={10}
              maxLength={3000}
              rows={6}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder={t(
                carouselTemplate
                  ? "Descreva a novidade, inclua a fonte, a data, o que ela faz, para quem está disponível e o impacto para o seu cliente."
                  : "Quero mostrar meu bolo de chocolate e convidar as pessoas para encomendar no fim de semana. Cores quentes, estilo artesanal…",
              )}
              disabled={busy}
              className="rounded-3xl p-5 text-base"
            />
          </div>
          <fieldset disabled={busy} className="space-y-3">
            <legend className="block text-sm font-medium">{t("Estrutura da criação")}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <label
                className={`cursor-pointer rounded-2xl border p-4 ${!carouselTemplate ? "border-primary bg-primary/10" : "border-border"}`}
              >
                <input
                  type="radio"
                  name="carouselTemplate"
                  checked={!carouselTemplate}
                  onChange={() => setCarouselTemplate("")}
                  className="mr-2 accent-current"
                />
                <strong>{t("Imagem única")}</strong>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("Uma imagem e uma legenda para revisar.")}
                </p>
              </label>
              {Object.entries(carouselTemplates).map(([id, template]) => (
                <label
                  key={id}
                  className={`cursor-pointer rounded-2xl border p-4 ${carouselTemplate === id ? "border-primary bg-primary/10" : "border-border"}`}
                >
                  <input
                    type="radio"
                    name="carouselTemplate"
                    checked={carouselTemplate === id}
                    onChange={() => {
                      setCarouselTemplate(id as CarouselTemplateId);
                      setFormat("feed");
                    }}
                    className="mr-2 accent-current"
                  />
                  <strong>{t(template.label)}</strong>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t(template.description)} {t("8 slides para revisar antes de publicar.")}
                  </p>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset disabled={busy} className="space-y-3">
            <legend className="block text-sm font-medium">
              {t("Onde essa ideia vai aparecer?")}
            </legend>
            <div className="flex flex-wrap gap-2">
              {Object.entries(formats)
                .filter(([key]) => !carouselTemplate || key === "feed")
                .map(([key, f]) => (
                  <label
                    key={key}
                    className={`inline-flex cursor-pointer items-center rounded-2xl border px-4 py-3 ${format === key ? "border-primary bg-primary/10" : "border-border"}`}
                  >
                    <input
                      type="radio"
                      name="format"
                      value={key}
                      checked={format === key}
                      onChange={() => setFormat(key as keyof typeof formats)}
                      className="mr-2 accent-current"
                    />
                    {t(f.label)}
                  </label>
                ))}
            </div>
          </fieldset>
          {error && (
            <Notice error>
              {error}{" "}
              <a href="/app/instagram/library" className="underline">
                {t("Abrir minhas criações")}
              </a>
            </Notice>
          )}
          <Button size="lg" disabled={busy} type="submit">
            {busy
              ? carouselTemplate
                ? `${t("Criando carrossel")}: ${progress}/8`
                : t("Criando sua postagem…")
              : carouselTemplate
                ? t("Gerar carrossel de 8 slides")
                : t("Gerar imagem e legenda")}
          </Button>
          <p className="text-sm text-muted-foreground">
            {t(
              "Texto e imagem usam o saldo compartilhado de IA da empresa. O consumo varia conforme a criação.",
            )}{" "}
            {carouselTemplate &&
              t(
                "Este modelo gera oito imagens, uma operação de IA por slide. Mantenha esta página aberta até concluir.",
              )}{" "}
            {canViewBilling && (
              <a href="/app/settings/billing" className="underline">
                {t("Consultar plano e uso")}
              </a>
            )}
          </p>
          {busy ? (
            <Notice>
              {t(
                carouselTemplate
                  ? "Cada slide é salvo na biblioteca ao terminar. A geração pode levar alguns minutos."
                  : "A imagem pode levar alguns minutos. Seu pedido já fica na biblioteca. Você não precisa enviar novamente.",
              )}
            </Notice>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t(
                "A imagem e a legenda ficam salvas para você revisar. Nada é publicado automaticamente.",
              )}
            </p>
          )}
        </div>
        <aside className="rounded-[2rem] border border-border bg-muted/30 p-7">
          {busy ? (
            <ImageGeneration format={format} />
          ) : (
            <div
              style={{ aspectRatio: formats[format].ratio }}
              className="flex items-center justify-center rounded-2xl border border-dashed border-border bg-background p-7 text-center"
            >
              <div>
                <p className="font-serif text-3xl">
                  {t("Aqui nasce")}
                  <br />
                  {t("sua próxima ideia.")}
                </p>
                <p className="mt-4 text-sm text-muted-foreground">{t(formats[format].label)}</p>
              </div>
            </div>
          )}
          <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
            {t("Dica: conte o que quer mostrar, para quem e qual sensação a imagem deve passar.")}
          </p>
        </aside>
      </form>
    </StudioShell>
  );
}
