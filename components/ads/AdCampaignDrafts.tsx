"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { apiClient } from "@/lib/api/client";
import { randomId } from "@/lib/random-id";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { parseBudgetCents, adCurrencySchema } from "@/lib/ads/schema";
import type { AdCampaignDraftDTO, AdDraftContextDTO, NativeAdAccount } from "@/lib/ads/types";

const API = "/api/v1/ads/meta/drafts";
const operationLabels: Record<string, string> = {
  queued: "Aguardando criação",
  executing: "Criando na Meta",
  awaiting_provider: "Aguardando a Meta",
  succeeded: "Criação confirmada: campanha, conjunto e anúncio pausados",
  failed: "Criação não concluída",
  uncertain: "Resultado ainda não confirmado. Não crie novamente",
  blocked: "Autorização ou revisão mudou. Confira a conexão",
  cancelled: "Criação cancelada",
};
function localDate(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function initialForm() {
  const start = new Date(Date.now() + 86400000).toISOString();
  return {
    id: randomId(),
    page: "",
    name: "",
    url: "",
    budget: "",
    start: localDate(start),
    end: localDate(new Date(Date.parse(start) + 7 * 86400000).toISOString()),
    image: "",
    message: "",
    title: "",
    revision: undefined as number | undefined,
  };
}

export function AdCampaignDrafts({ account }: { account: NativeAdAccount }) {
  const t = useT();
  const languageTag = useTagDeIdioma();
  const org = useActiveOrg();
  const user = useUser();
  const readonly = user?.support?.access_mode === "support_readonly";
  const queryClient = useQueryClient();
  const [form, setForm] = useState(initialForm);
  const [review, setReview] = useState<AdCampaignDraftDTO | null>(null);
  const [approvedBudget, setApprovedBudget] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const key = ["ads", "native", "drafts", org?.orgId];
  const context = useQuery({
    queryKey: key,
    queryFn: () => apiClient.get<{ data: AdDraftContextDTO }>(API),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const mutation = useMutation({
    mutationFn: async (command: { endpoint: string; body: unknown; patch?: boolean }) =>
      command.patch
        ? apiClient.patch<{ data: AdCampaignDraftDTO }>(command.endpoint, command.body)
        : apiClient.post<{ data: AdCampaignDraftDTO }>(command.endpoint, command.body),
    retry: false,
  });
  const latest = useQuery({
    queryKey: [...key, "operation", review?.id],
    queryFn: () => apiClient.get<{ data: AdCampaignDraftDTO }>(`${API}/${review!.id}`),
    enabled: Boolean(review?.operation),
    refetchInterval: (query) =>
      ["queued", "executing", "awaiting_provider"].includes(
        query.state.data?.data.operation?.status ?? "",
      )
        ? 5000
        : false,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const shown = latest.data && latest.data.data.id === review?.id ? latest.data.data : review;
  const currency = adCurrencySchema.safeParse(account.currency);
  const pages =
    context.data?.data.pages.filter((page) => page.connection_id === account.connection_id) ?? [];
  const images = context.data?.data.images ?? [];
  const history =
    context.data?.data.drafts.filter(
      (draft) =>
        draft.ad_account_asset_id === account.asset_id &&
        draft.connection_id === account.connection_id,
    ) ?? [];
  const money = (cents: number, currencyCode: string) =>
    new Intl.NumberFormat(languageTag, { style: "currency", currency: currencyCode }).format(
      cents / 100,
    );
  function change<K extends keyof typeof form>(field: K, value: (typeof form)[K]) {
    setForm((old) => ({ ...old, [field]: value }));
    setReview(null);
    setApprovedBudget(false);
    setError(null);
  }
  async function command(endpoint: string, body: unknown, patch = false) {
    if (readonly || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    try {
      const response = await mutation.mutateAsync({ endpoint, body, patch });
      setReview(response.data);
      setApprovedBudget(false);
      void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.removeQueries({ queryKey: [...key, "operation", response.data.id] });
      return response.data;
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : t("Não foi possível concluir. Confira o resultado antes de tentar novamente."),
      );
    } finally {
      inFlight.current = false;
    }
  }
  async function save() {
    const budget = parseBudgetCents(form.budget);
    if (budget === null || !currency.success) {
      setError(
        t(
          "Informe um orçamento diário entre 2 e 1.000 na moeda da conta, com até duas casas decimais.",
        ),
      );
      return;
    }
    const start = new Date(form.start),
      end = new Date(form.end);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
      setError(t("Confira o período da campanha."));
      return;
    }
    const body = {
      id: form.id,
      connection_id: account.connection_id,
      ad_account_asset_id: account.asset_id,
      page_asset_id: form.page,
      name: form.name,
      destination_url: form.url,
      daily_budget_cents: budget,
      currency: currency.data,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      creative: { studio_item_id: form.image, message: form.message, title: form.title },
      ...(form.revision ? { revision: form.revision } : {}),
    };
    const saved = await command(
      form.revision ? `${API}/${form.id}` : API,
      body,
      Boolean(form.revision),
    );
    if (saved) setForm((current) => ({ ...current, id: saved.id, revision: saved.revision }));
  }
  async function openDraft(id: string) {
    setError(null);
    setApprovedBudget(false);
    try {
      const response = await apiClient.get<{ data: AdCampaignDraftDTO }>(`${API}/${id}`);
      setReview(response.data);
      queryClient.removeQueries({ queryKey: [...key, "operation", id] });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Não foi possível abrir a revisão."));
    }
  }
  function edit(draft: AdCampaignDraftDTO) {
    setForm({
      id: draft.id,
      page: draft.page_asset_id,
      name: draft.name,
      url: draft.destination_url,
      budget: (draft.daily_budget_cents / 100).toFixed(2),
      start: localDate(draft.starts_at),
      end: localDate(draft.ends_at),
      image: draft.creative.studio_item_id,
      message: draft.creative.message,
      title: draft.creative.title,
      revision: draft.revision,
    });
    setReview(null);
    setApprovedBudget(false);
  }
  const busy = mutation.isPending;
  return (
    <section
      className="space-y-5 rounded-lg border p-5"
      aria-label={t("Campanha de tráfego em rascunho")}
    >
      <div>
        <h2 className="font-semibold">{t("Prepare uma campanha de tráfego")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "Use uma imagem pronta do Studio. Revise os valores e crie na Meta com campanha, conjunto e anúncio pausados.",
          )}
        </p>
      </div>
      {(error || context.error || latest.error) && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
        >
          {error ??
            (context.error instanceof Error
              ? context.error.message
              : latest.error instanceof Error
                ? latest.error.message
                : t("Não foi possível consultar o resultado. Atualize antes de criar novamente."))}
        </div>
      )}
      {!currency.success && (
        <p role="alert" className="text-sm">
          {t(
            "Esta entrega permite criar campanhas apenas em contas BRL, USD ou EUR. A leitura continua disponível.",
          )}
        </p>
      )}
      {context.isLoading && <p role="status">{t("Carregando imagens e rascunhos…")}</p>}
      {context.data && currency.success && (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={readonly || busy} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ad-draft-name">{t("Nome da campanha")}</Label>
                <Input
                  id="ad-draft-name"
                  value={form.name}
                  maxLength={200}
                  required
                  onChange={(event) => change("name", event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ad-draft-page">{t("Página do Facebook")}</Label>
                <select
                  id="ad-draft-page"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  required
                  value={form.page}
                  onChange={(event) => change("page", event.target.value)}
                >
                  <option value="">{t("Escolha a Página")}</option>
                  {pages.map((page) => (
                    <option key={page.asset_id} value={page.asset_id}>
                      {page.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ad-draft-url">{t("Destino do anúncio")}</Label>
              <Input
                id="ad-draft-url"
                type="url"
                placeholder="https://"
                required
                value={form.url}
                onChange={(event) => change("url", event.target.value)}
              />
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="ad-draft-budget">
                  {t("Orçamento diário")} · {account.currency}
                </Label>
                <Input
                  id="ad-draft-budget"
                  inputMode="decimal"
                  placeholder="35,00"
                  required
                  value={form.budget}
                  onChange={(event) => change("budget", event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ad-draft-start">{t("Início")}</Label>
                <Input
                  id="ad-draft-start"
                  type="datetime-local"
                  required
                  value={form.start}
                  onChange={(event) => change("start", event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ad-draft-end">{t("Fim")}</Label>
                <Input
                  id="ad-draft-end"
                  type="datetime-local"
                  required
                  value={form.end}
                  min={form.start}
                  onChange={(event) => change("end", event.target.value)}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {t(
                "Digite o período no horário deste dispositivo. A revisão mostra o horário da conta de anúncios.",
              )}
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="ad-draft-image">{t("Imagem do Studio")}</Label>
              <select
                id="ad-draft-image"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                required
                value={form.image}
                onChange={(event) => change("image", event.target.value)}
              >
                <option value="">{t("Escolha a imagem")}</option>
                {images.map((image) => (
                  <option key={image.id} value={image.id}>
                    {image.name}
                  </option>
                ))}
              </select>
              {images.length === 0 && (
                <a href="/app/instagram" className="inline-block text-sm underline">
                  {t("Criar uma imagem no Studio")}
                </a>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ad-draft-title">{t("Título do anúncio")}</Label>
              <Input
                id="ad-draft-title"
                required
                value={form.title}
                maxLength={100}
                onChange={(event) => change("title", event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ad-draft-message">{t("Texto do anúncio")}</Label>
              <Textarea
                id="ad-draft-message"
                required
                value={form.message}
                maxLength={2000}
                onChange={(event) => change("message", event.target.value)}
              />
            </div>
            <p className="text-sm text-muted-foreground">
              {t(
                "Público desta entrega: Brasil, 18 a 65 anos, feed do Facebook. Objetivo: visitas ao link.",
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy || !pages.length || !images.length}>
                {busy ? t("Salvando…") : t("Salvar e revisar")}
              </Button>
              {(form.revision !== undefined || review !== null) && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setForm(initialForm());
                    setReview(null);
                    setApprovedBudget(false);
                    setError(null);
                  }}
                >
                  {t("Novo rascunho")}
                </Button>
              )}
            </div>
          </fieldset>
        </form>
      )}
      {shown && (
        <div
          className="space-y-4 rounded-md border bg-muted/30 p-4"
          aria-label={t("Revisão da campanha")}
        >
          <div>
            <h3 className="font-semibold">{shown.name}</h3>
            <p className="text-xs text-muted-foreground">
              {t("Revisão")} {shown.revision} · {account.name}
            </p>
          </div>
          <dl className="grid gap-3 text-sm md:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">{t("Orçamento diário")}</dt>
              <dd className="font-medium">{money(shown.daily_budget_cents, shown.currency)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("Página")}</dt>
              <dd>
                {pages.find((page) => page.asset_id === shown.page_asset_id)?.name ??
                  t("Página indisponível")}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("Destino")}</dt>
              <dd className="break-all">{shown.destination_url}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("Período na conta")}</dt>
              <dd>
                {new Date(shown.starts_at).toLocaleString(languageTag, {
                  timeZone: account.timezone ?? "UTC",
                })}{" "}
                →{" "}
                {new Date(shown.ends_at).toLocaleString(languageTag, {
                  timeZone: account.timezone ?? "UTC",
                })}{" "}
                · {account.timezone ?? "UTC"}
              </dd>
            </div>
          </dl>
          <p className="text-sm">{shown.creative.title}</p>
          <p className="text-sm whitespace-pre-wrap">{shown.creative.message}</p>
          <p className="text-xs text-muted-foreground">
            {images.find((image) => image.id === shown.creative.studio_item_id)?.name ??
              t("Imagem do Studio")}
          </p>
          {images.find((image) => image.id === shown.creative.studio_item_id)?.preview_url && (
            <Image
              src={images.find((image) => image.id === shown.creative.studio_item_id)!.preview_url!}
              alt={t("Imagem selecionada para o anúncio")}
              width={512}
              height={640}
              unoptimized
              className="max-h-60 max-w-full rounded-md object-contain"
            />
          )}
          <p className="text-sm">
            {t(
              "Brasil · 18 a 65 anos · feed do Facebook. A criação mantém os três objetos de veiculação pausados; ativação exige outra ação.",
            )}
          </p>
          {shown.operation ? (
            <div role="status" className="space-y-2 text-sm">
              <p className="font-medium">
                {t(operationLabels[shown.operation.status] ?? "Confira o resultado")}
              </p>
              {shown.operation.error_message && <p>{shown.operation.error_message}</p>}
              <dl>
                {Object.entries(shown.operation.external_ids)
                  .filter(([field]) => field !== "image_hash")
                  .map(([field, id]) => (
                    <div key={field} className="flex flex-wrap gap-2">
                      <dt>
                        {field === "campaign_id"
                          ? t("Campanha")
                          : field === "adset_id"
                            ? t("Conjunto")
                            : field === "ad_id"
                              ? t("Anúncio")
                              : t("Criativo")}
                      </dt>
                      <dd>{id}</dd>
                    </div>
                  ))}
              </dl>
              <Button
                variant="outline"
                type="button"
                onClick={() => void latest.refetch()}
                disabled={latest.isFetching}
              >
                {t("Atualizar resultado")}
              </Button>
            </div>
          ) : shown.status === "approved" ? (
            <Button
              type="button"
              disabled={readonly || busy || !shown.approved_hash}
              onClick={() =>
                void command(`${API}/${shown.id}/create`, {
                  revision: shown.revision,
                  approved_hash: shown.approved_hash,
                })
              }
            >
              {busy ? t("Enviando…") : t("Criar pausada na Meta")}
            </Button>
          ) : (
            <div className="space-y-3">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={approvedBudget}
                  disabled={readonly || busy}
                  onChange={(event) => setApprovedBudget(event.target.checked)}
                />
                <span>
                  {t("Revisei conta, Página, imagem, destino, período e orçamento diário")}{" "}
                  {money(shown.daily_budget_cents, shown.currency)}.
                </span>
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={readonly || busy || !approvedBudget}
                  onClick={() =>
                    void command(`${API}/${shown.id}/approve`, {
                      revision: shown.revision,
                      review_hash: shown.review_hash,
                      daily_budget_cents: shown.daily_budget_cents,
                      currency: shown.currency,
                    })
                  }
                >
                  {busy ? t("Aprovando…") : t("Aprovar esta revisão")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={readonly || busy}
                  onClick={() => edit(shown)}
                >
                  {t("Editar rascunho")}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      {history.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t("Rascunhos desta conta")}</h3>
          {history.map((draft) => (
            <div
              key={draft.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
            >
              <span>
                {draft.name} · {money(draft.daily_budget_cents, draft.currency)} ·{" "}
                {t(
                  draft.operation
                    ? (operationLabels[draft.operation.status] ?? "Confira o resultado")
                    : draft.status === "approved"
                      ? "Revisão aprovada"
                      : "Rascunho",
                )}
              </span>
              <Button
                variant="outline"
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => void openDraft(draft.id)}
              >
                {t("Ver revisão e resultado")}
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
