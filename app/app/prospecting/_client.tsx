"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { randomId } from "@/lib/random-id";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import {
  safePublicLink,
  type CampaignConfig,
  type CampaignInputConfig,
  type Prospect,
  type SearchInput,
} from "@/lib/prospecting/schema";
import { ProspectingSellerProfile, type SellerProfile } from "./_seller-profile";
import { ProspectingScheduleForm } from "./_schedule";
import type { ProspectingSchedule } from "@/lib/prospecting/schedule";

type Campaign = {
  id: string;
  name: string;
  status: string;
  search_status: string;
  error: string | null;
  config: CampaignConfig | null;
  search?: SearchInput;
  result_count: number;
  skipped_count: number;
  cost_usd: string | null;
  next_send_at: string;
};
type Candidate = {
  id: string;
  campaign_id: string;
  data: Prospect;
  progress: string;
  message_status: string | null;
  error: string | null;
  conversation_id: string | null;
};
type State = {
  configured: boolean;
  schedule?: ProspectingSchedule | null;
  campaigns: Campaign[];
  candidates: Candidate[];
  seller: SellerProfile;
  channels: {
    id: string;
    display_name: string | null;
    phone_number: string | null;
    status: string;
  }[];
  stages: { id: string; name: string; pipeline_id: string; pipeline_name: string }[];
};
const labels: Record<string, string> = {
  draft: "Preparar campanha",
  running: "Em andamento",
  paused: "Pausada",
  completed: "Abordagens concluídas",
  starting: "Iniciando busca",
  succeeded: "Busca concluída",
  failed: "Revisar falha",
  unknown: "Busca sem confirmação",
  new: "Encontrado",
  queued: "Na fila",
  sending: "Preparando abordagem",
  sent: "Abordado",
  skipped: "Não abordado",
  replied: "Respondeu",
  qualified: "Qualificado",
};
const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm";
const emptyConfig: CampaignInputConfig = {
  channel_session_id: "",
  pipeline_id: "",
  stage_id: "",
  qualified_stage_id: "",
  instruction: "",
  qualification: "",
  daily_limit: 10,
  interval_minutes: 15,
  legal_basis_ref: "",
};
export function ProspectingClient() {
  const t = useT();
  const query = useQuery({
    queryKey: ["prospecting"],
    queryFn: async () => (await apiClient.get<{ data: State }>("/api/v1/prospecting")).data,
    refetchInterval: 10000,
  });
  const data = query.data;
  const searchAttempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [settings, setSettings] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [niche, setNiche] = useState("");
  const [source, setSource] = useState<"google_maps" | "instagram">("google_maps");
  const [location, setLocation] = useState("");
  const [limit, setLimit] = useState(20);
  const [budget, setBudget] = useState(1);
  const [enrich, setEnrich] = useState(true);
  const [campaignDrafts, setCampaignDrafts] = useState<Record<string, CampaignInputConfig>>({});
  const [showSellerProfile, setShowSellerProfile] = useState(false);
  const campaign = data?.campaigns.find((c) => c.id === selected) ?? data?.campaigns[0];
  const seller = data?.seller ?? { seller_name: "Sara", company_name: "", offer: "" };
  const activeChannels = data?.channels.filter((channel) => channel.status === "WORKING") ?? [];
  const pipelines = [
    ...new Map(data?.stages.map((stage) => [stage.pipeline_id, stage.pipeline_name])).entries(),
  ];
  const defaultConfig: CampaignInputConfig = {
    ...emptyConfig,
    channel_session_id: activeChannels.length === 1 ? activeChannels[0]!.id : "",
    pipeline_id: pipelines.length === 1 ? pipelines[0]![0] : "",
    instruction: seller.offer,
    qualification: t("Demonstrou interesse na oferta e quer avançar para uma conversa comercial."),
  };
  // Activated campaigns keep their original identity and configuration.
  // An unsaved draft belongs to one campaign and survives background refetches.
  const config = campaign?.config ?? (campaign && campaignDrafts[campaign.id]) ?? defaultConfig;
  const funil = config.pipeline_id;
  function setConfig(
    update: CampaignInputConfig | ((previous: CampaignInputConfig) => CampaignInputConfig),
  ) {
    if (!campaign || campaign.config) return;
    setCampaignDrafts((drafts) => ({
      ...drafts,
      [campaign.id]:
        typeof update === "function" ? update(drafts[campaign.id] ?? defaultConfig) : update,
    }));
  }
  const candidates = data?.candidates.filter((c) => c.campaign_id === campaign?.id) ?? [];
  async function perform(body: unknown, message: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiClient.post("/api/v1/prospecting", body);
      await query.refetch();
      setNotice(message);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Não foi possível concluir a operação."));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const update = <K extends keyof CampaignInputConfig>(field: K, value: CampaignInputConfig[K]) =>
    setConfig((c) => ({ ...c, [field]: value }));
  const count = (states: string[]) => candidates.filter((c) => states.includes(c.progress)).length;
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">CRM</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">{t("Prospecção")}</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            {t(
              "Da busca ao Inbox: encontre empresas, delegue a abordagem e acompanhe quem avança no funil.",
            )}
          </p>
        </div>
        <Button variant="outline" onClick={() => setSettings((s) => !s)}>
          {t("Configurar provedor de busca")}
        </Button>
      </header>
      <Card className="rounded-[1.35rem] border-border/60 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <Badge className="rounded-full px-3 py-1">{t("Vendedora de prospecção")}</Badge>
            <h2 className="mt-3 text-xl font-semibold tracking-tight">
              {seller.seller_name}
              {seller.company_name ? ` · ${seller.company_name}` : ""}
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              {t(
                "A mesma vendedora em todas as buscas. A abordagem se adapta ao segmento, mantendo sua identidade e oferta.",
              )}
            </p>
          </div>
          <Button variant="outline" onClick={() => setShowSellerProfile((open) => !open)}>
            {t("Configurar apresentação e oferta")}
          </Button>
        </div>
      </Card>
      {data && (showSellerProfile || !seller.offer) && (
        <ProspectingSellerProfile
          seller={seller}
          busy={busy}
          onSave={async (profile) => {
            const saved = await perform(
              { action: "save_seller", profile },
              t("Apresentação e oferta salvas."),
            );
            if (saved) setShowSellerProfile(false);
            return saved;
          }}
        />
      )}
      {(error || query.error) && (
        <div
          role="alert"
          className="rounded-lg border border-destructive p-4 text-sm text-destructive"
        >
          {error ??
            (query.error instanceof Error
              ? query.error.message
              : t("Falha ao carregar a prospecção."))}
        </div>
      )}
      {notice && (
        <div role="status" className="rounded-lg border bg-muted/30 p-3 text-sm">
          {notice}
        </div>
      )}
      {!data && !query.error && <p role="status">{t("Carregando campanhas…")}</p>}
      {(settings || data?.configured === false) && (
        <Card className="p-5">
          <form
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await perform({ action: "configure", api_key: key }, t("Chave de busca salva."))
              ) {
                setKey("");
                setSettings(false);
              }
            }}
          >
            <div className="flex-1">
              <Label htmlFor="prospecting-key">{t("Chave da Apify")}</Label>
              <Input
                id="prospecting-key"
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                required
                minLength={10}
                className="mt-2"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {t("A chave fica cifrada no servidor. Cada busca tem seu próprio limite de gasto.")}
              </p>
            </div>
            <Button disabled={busy || !key} type="submit">
              {t("Salvar chave")}
            </Button>
          </form>
        </Card>
      )}
      {data?.configured && (
        <ProspectingScheduleForm
          key={JSON.stringify(data.schedule?.schedule_config)}
          schedule={data.schedule ?? null}
          seller={seller}
          campaigns={data.campaigns}
          busy={busy}
          perform={perform}
        />
      )}
      <div className="grid items-start gap-6 lg:grid-cols-[320px_1fr]">
        <aside className="flex flex-col gap-5 lg:sticky lg:top-6">
          {campaign && !showSearch && (
            <Button variant="outline" onClick={() => setShowSearch(true)}>
              {t("Nova busca de empresas")}
            </Button>
          )}
          <Card
            className={`rounded-[1.35rem] border-border/60 p-5 shadow-[0_18px_50px_-46px_rgba(15,23,42,0.7)] ${campaign && !showSearch ? "hidden" : ""}`}
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">{t("1. Encontrar empresas")}</h2>
              {campaign && (
                <Button variant="ghost" size="sm" onClick={() => setShowSearch(false)}>
                  {t("Fechar")}
                </Button>
              )}
            </div>
            <form
              className="mt-4 space-y-4"
              onSubmit={async (e) => {
                e.preventDefault();
                const fingerprint = JSON.stringify([
                  source,
                  niche,
                  location,
                  limit,
                  budget,
                  enrich,
                ]);
                if (searchAttempt.current?.fingerprint !== fingerprint)
                  searchAttempt.current = { fingerprint, id: randomId() };
                const success = await perform(
                  {
                    action: "search",
                    request_id: searchAttempt.current.id,
                    search: {
                      source,
                      name: `${niche} · ${location}`.slice(0, 120),
                      niche,
                      location,
                      limit,
                      budget_usd: budget,
                      enrich,
                    },
                  },
                  t("Solicitação registrada. Acompanhe o estado da busca nesta tela."),
                );
                if (success) {
                  setSelected(null);
                  setShowSearch(false);
                  searchAttempt.current = null;
                }
              }}
            >
              <div>
                <Label htmlFor="prospecting-source">{t("Onde buscar")}</Label>
                <select
                  id="prospecting-source"
                  className={selectClass}
                  value={source}
                  onChange={(e) => setSource(e.target.value as "google_maps" | "instagram")}
                >
                  <option value="google_maps">Google Maps</option>
                  <option value="instagram">Instagram</option>
                </select>
                {source === "instagram" && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t(
                      "Busca perfis públicos por segmento e região, sem garantir localização. A abordagem usa WhatsApp quando há telefone público. A integração do Instagram não permite iniciar DM para perfis coletados; respostas e automações de comentários ficam na central do Instagram.",
                    )}{" "}
                    <Link href="/app/instagram" className="underline">
                      {t("Abrir Instagram")}
                    </Link>
                  </p>
                )}
              </div>
              <div>
                <Label htmlFor="prospecting-niche">{t("Público ou segmento")}</Label>
                <Input
                  id="prospecting-niche"
                  value={niche}
                  onChange={(e) => setNiche(e.target.value)}
                  placeholder={t("Ex.: clínicas, restaurantes ou escritórios")}
                  minLength={2}
                  maxLength={120}
                  required
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="prospecting-location">{t("Cidade ou região")}</Label>
                <Input
                  id="prospecting-location"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder={t("Ex.: São Paulo, SP")}
                  minLength={2}
                  maxLength={160}
                  required
                  className="mt-1"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="prospecting-limit">{t("Até quantas empresas")}</Label>
                  <Input
                    id="prospecting-limit"
                    type="number"
                    min={1}
                    max={100}
                    value={limit}
                    onChange={(e) => setLimit(Number(e.target.value))}
                    required
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="prospecting-budget">{t("Teto da busca (US$)")}</Label>
                  <Input
                    id="prospecting-budget"
                    type="number"
                    min={0.5}
                    max={10}
                    step={0.5}
                    value={budget}
                    onChange={(e) => setBudget(Number(e.target.value))}
                    required
                    className="mt-1"
                  />
                </div>
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enrich}
                  onChange={(e) => setEnrich(e.target.checked)}
                  className="mt-1"
                />
                {t("Enriquecer com e-mails comerciais e redes encontradas no site")}
              </label>
              <p className="text-xs text-muted-foreground">
                {t(
                  "A pesquisa usa seu saldo da Apify. A quantidade encontrada pode ser menor que o limite. Nenhuma abordagem começa nesta etapa.",
                )}
              </p>
              <Button className="w-full" type="submit" disabled={busy || !data?.configured}>
                {busy ? t("Aguarde…") : t("Buscar empresas")}
              </Button>
            </form>
          </Card>
          <section>
            <h2 className="mb-3 text-sm font-semibold">{t("Suas campanhas")}</h2>
            <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
              {data?.campaigns.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    setSelected(c.id);
                    setShowSearch(false);
                    setNotice(null);
                  }}
                  className={`w-full rounded-lg border p-3 text-left ${campaign?.id === c.id ? "border-primary bg-primary/5" : "bg-card"}`}
                >
                  <span className="block text-sm font-medium">{c.name}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {t(labels[c.status] ?? c.status)} · {c.result_count} {t("empresas")}
                  </span>
                </button>
              ))}
            </div>
          </section>
        </aside>
        <div className="min-w-0 space-y-5">
          {!campaign && (
            <Card className="flex min-h-80 flex-col items-center justify-center gap-3 p-8 text-center">
              <h2 className="text-xl font-semibold">{t("Sua próxima conversa começa aqui")}</h2>
              <p className="max-w-md text-sm text-muted-foreground">
                {t(
                  "Escolha um segmento e uma região. Depois da pesquisa, defina como a IA deve abordar e o que precisa confirmar para qualificar.",
                )}
              </p>
            </Card>
          )}
          {campaign && (
            <>
              <Card className="p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-semibold">{campaign.name}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t(labels[campaign.search_status] ?? campaign.search_status)}
                      {campaign.cost_usd !== null
                        ? ` · US$ ${Number(campaign.cost_usd).toFixed(2)}`
                        : ""}
                    </p>
                  </div>
                  <Badge variant="outline">{t(labels[campaign.status] ?? campaign.status)}</Badge>
                </div>
                {campaign.error && (
                  <p role="alert" className="mt-4 rounded-md bg-destructive/10 p-3 text-sm">
                    {campaign.error}
                  </p>
                )}
                <div className="mt-5 grid grid-cols-2 gap-4 md:grid-cols-4">
                  {[
                    [t("Encontrados"), candidates.length],
                    [t("Na fila"), count(["queued", "sending"])],
                    [t("Responderam"), count(["replied", "qualified"])],
                    [t("Qualificados"), count(["qualified"])],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <p className="text-2xl font-semibold tabular-nums">{value}</p>
                      <p className="text-xs text-muted-foreground">{label}</p>
                    </div>
                  ))}
                </div>
                {campaign.skipped_count > 0 && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {campaign.skipped_count}{" "}
                    {t("resultados repetidos ou indisponíveis foram desconsiderados.")}
                  </p>
                )}
                {campaign.config && (
                  <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                    <p className="text-sm text-muted-foreground">
                      {t("Ritmo:")} {campaign.config.daily_limit}{" "}
                      {t("abordagens em 24 horas, com pelo menos")}{" "}
                      {campaign.config.interval_minutes} {t("minutos entre elas.")}
                    </p>
                    {campaign.status === "running" ? (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          perform(
                            { action: "pause", id: campaign.id },
                            t("Novas abordagens pausadas."),
                          )
                        }
                      >
                        {t("Pausar abordagens")}
                      </Button>
                    ) : campaign.status === "paused" ? (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          perform({ action: "resume", id: campaign.id }, t("Campanha retomada."))
                        }
                      >
                        {t("Retomar fila")}
                      </Button>
                    ) : null}
                  </div>
                )}
              </Card>
              {campaign.status === "draft" &&
                campaign.search_status === "succeeded" &&
                candidates.length > 0 && (
                  <Card className="p-5">
                    <h2 className="text-lg font-semibold">{t("2. Preparar abordagens")}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t(
                        "A vendedora se apresenta, explica como sua empresa ajuda e acompanha as respostas no Inbox.",
                      )}
                    </p>
                    <p className="mt-3 text-sm" data-testid="prospecting-niche-context">
                      {t("Segmento desta busca:")} {campaign.search?.niche ?? campaign.name}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t(
                        "O segmento orienta os exemplos da conversa; a oferta continua sendo a da sua empresa.",
                      )}
                    </p>
                    <form
                      className="mt-5 space-y-4"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const startConfig: CampaignInputConfig = {
                          ...(campaign.config ? { agent_id: campaign.config.agent_id } : {}),
                          channel_session_id: config.channel_session_id,
                          pipeline_id: config.pipeline_id,
                          stage_id: config.stage_id,
                          qualified_stage_id: config.qualified_stage_id,
                          instruction: config.instruction,
                          qualification: config.qualification,
                          daily_limit: config.daily_limit,
                          interval_minutes: config.interval_minutes,
                          legal_basis_ref: config.legal_basis_ref,
                        };
                        void perform(
                          { action: "start", id: campaign.id, config: startConfig },
                          t(
                            "Campanha iniciada. A primeira abordagem será preparada após um minuto.",
                          ),
                        );
                      }}
                    >
                      {campaign.config && (
                        <p className="text-sm text-muted-foreground">
                          {t(
                            "Esta campanha já começou a preparar contatos. Sua configuração foi preservada para retomar com segurança.",
                          )}
                        </p>
                      )}
                      <fieldset disabled={!!campaign.config} className="space-y-4">
                        <div className="space-y-4">
                          <div>
                            <Label htmlFor="prospecting-channel">{t("Conexão de saída")}</Label>
                            <select
                              id="prospecting-channel"
                              className={`${selectClass} mt-1`}
                              value={config.channel_session_id}
                              onChange={(e) => update("channel_session_id", e.target.value)}
                              required
                            >
                              <option value="">{t("Escolha uma conexão ativa")}</option>
                              {data?.channels
                                .filter((c) => c.status === "WORKING")
                                .map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.display_name ?? c.phone_number ?? c.id}
                                  </option>
                                ))}
                            </select>
                            <Link className="text-xs underline" href="/app/connections">
                              {t("Ver conexões e proteções de envio")}
                            </Link>
                          </div>
                          <div>
                            <Label htmlFor="prospecting-pipeline">{t("Funil")}</Label>
                            <select
                              id="prospecting-pipeline"
                              className={`${selectClass} mt-1`}
                              value={funil}
                              required
                              onChange={(e) => {
                                setConfig((c) => ({
                                  ...c,
                                  pipeline_id: e.target.value,
                                  stage_id: "",
                                  qualified_stage_id: "",
                                }));
                              }}
                            >
                              <option value="">{t("Escolha o funil")}</option>
                              {[
                                ...new Map(
                                  data?.stages.map((s) => [s.pipeline_id, s.pipeline_name]),
                                ).entries(),
                              ].map(([id, name]) => (
                                <option key={id} value={id}>
                                  {name}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="grid gap-4 md:grid-cols-2">
                            {(
                              [
                                ["stage_id", "Etapa inicial"],
                                ["qualified_stage_id", "Etapa de qualificados"],
                              ] as const
                            ).map(([field, label]) => (
                              <div key={field}>
                                <Label htmlFor={`prospecting-${field}`}>{t(label)}</Label>
                                <select
                                  id={`prospecting-${field}`}
                                  className={`${selectClass} mt-1`}
                                  required
                                  value={config[field]}
                                  onChange={(e) => update(field, e.target.value)}
                                >
                                  <option value="">{t("Escolha a etapa")}</option>
                                  {data?.stages
                                    .filter((s) => s.pipeline_id === funil)
                                    .map((s) => (
                                      <option key={s.id} value={s.id}>
                                        {s.name}
                                      </option>
                                    ))}
                                </select>
                              </div>
                            ))}
                          </div>
                          <div>
                            <Label htmlFor="prospecting-instruction">
                              {t("Oferta desta campanha")}
                            </Label>
                            <Textarea
                              id="prospecting-instruction"
                              value={config.instruction}
                              onChange={(e) => update("instruction", e.target.value)}
                              required
                              minLength={10}
                              maxLength={2000}
                              className="mt-1"
                              placeholder={t(
                                "Descreva sua oferta e o objetivo da primeira conversa.",
                              )}
                            />
                          </div>
                          <div>
                            <Label htmlFor="prospecting-qualification">
                              {t("Quando considerar o cliente qualificado")}
                            </Label>
                            <Textarea
                              id="prospecting-qualification"
                              value={config.qualification}
                              onChange={(e) => update("qualification", e.target.value)}
                              required
                              minLength={10}
                              maxLength={2000}
                              className="mt-1"
                              placeholder={t(
                                "Ex.: confirmou a necessidade, participa da decisão e deseja conversar sobre a solução.",
                              )}
                            />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <Label htmlFor="prospecting-daily">{t("Máximo em 24 horas")}</Label>
                            <Input
                              id="prospecting-daily"
                              type="number"
                              min={1}
                              max={50}
                              required
                              value={config.daily_limit}
                              onChange={(e) => update("daily_limit", Number(e.target.value))}
                              className="mt-1"
                            />
                          </div>
                          <div>
                            <Label htmlFor="prospecting-spacing">
                              {t("Intervalo mínimo (minutos)")}
                            </Label>
                            <Input
                              id="prospecting-spacing"
                              type="number"
                              min={5}
                              max={1440}
                              required
                              value={config.interval_minutes}
                              onChange={(e) => update("interval_minutes", Number(e.target.value))}
                              className="mt-1"
                            />
                          </div>
                        </div>
                        <div>
                          <Label htmlFor="prospecting-basis">
                            {t("Referência da avaliação de legítimo interesse")}
                          </Label>
                          <Input
                            id="prospecting-basis"
                            value={config.legal_basis_ref}
                            onChange={(e) => update("legal_basis_ref", e.target.value)}
                            minLength={3}
                            maxLength={500}
                            required
                            className="mt-1"
                          />
                          <p className="mt-1 text-xs text-muted-foreground">
                            {t(
                              "Informe a referência real da avaliação que fundamenta esta prospecção. Isso não registra consentimento dos contatos.",
                            )}
                          </p>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t(
                            "Ao iniciar, os contatos novos com telefone entram no funil. Contatos já existentes são preservados. A fila faz uma primeira abordagem; respostas seguem no Inbox. Uma mensagem já em transmissão pode concluir após a pausa.",
                          )}
                        </p>
                      </fieldset>
                      <Button
                        type="submit"
                        disabled={
                          busy ||
                          !seller.offer ||
                          !data?.channels.some((c) => c.status === "WORKING")
                        }
                      >
                        {t("Iniciar abordagens")}
                      </Button>
                    </form>
                  </Card>
                )}
              {candidates.length > 0 && (
                <Card className="overflow-hidden">
                  <div className="border-b p-5">
                    <h2 className="text-lg font-semibold">{t("3. Acompanhar resultados")}</h2>
                    <p className="text-sm text-muted-foreground">
                      {t(
                        "Encontrado é diferente de qualificado. A qualificação depende do que for confirmado na conversa.",
                      )}
                    </p>
                  </div>
                  <div className="max-h-[34rem] overflow-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="sticky top-0 z-10 border-b bg-card text-xs text-muted-foreground">
                        <tr>
                          <th className="p-4">{t("Empresa")}</th>
                          <th className="p-4">{t("Informações")}</th>
                          <th className="p-4">{t("Progresso")}</th>
                          <th className="p-4">{t("Conversa")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {candidates.map((c) => (
                          <tr key={c.id} className="border-b last:border-0">
                            <td className="p-4 align-top">
                              <p className="font-medium">{c.data.name}</p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {c.data.category}
                              </p>
                              <p className="mt-1 text-xs">{c.data.phone ?? t("Sem telefone")}</p>
                            </td>
                            <td className="max-w-64 p-4 align-top">
                              <p className="text-xs text-muted-foreground">{c.data.address}</p>
                              {safePublicLink(c.data.website) && (
                                <a
                                  className="mt-1 block underline"
                                  href={safePublicLink(c.data.website)}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {t("Site da empresa")}
                                </a>
                              )}
                              <p className="mt-1 text-xs text-muted-foreground">
                                {c.data.rating ?? "—"} ★ · {c.data.reviews ?? 0} {t("avaliações")}
                              </p>
                              {c.data.emails.map((email) => (
                                <p key={email} className="mt-1 text-xs break-all">
                                  {email}
                                </p>
                              ))}
                            </td>
                            <td className="max-w-64 p-4 align-top">
                              <Badge variant="outline">{t(labels[c.progress] ?? c.progress)}</Badge>
                              {c.error && (
                                <p className="mt-2 text-xs text-muted-foreground">{c.error}</p>
                              )}
                              {c.message_status && (
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {t("Mensagem:")} {c.message_status}
                                </p>
                              )}
                            </td>
                            <td className="p-4 align-top">
                              {c.conversation_id && (
                                <Link
                                  className="underline"
                                  href={`/app/inbox?id=${c.conversation_id}`}
                                >
                                  {t("Abrir no Inbox")}
                                </Link>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
