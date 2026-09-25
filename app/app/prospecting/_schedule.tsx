"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import type { ScheduleConfig, CampaignConfig } from "@/lib/prospecting/schema";
import type { ProspectingSchedule } from "@/lib/prospecting/schedule";

const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm";
export function ProspectingScheduleForm({
  schedule,
  campaigns,
  busy,
  perform,
}: {
  schedule: ProspectingSchedule | null;
  campaigns: { id: string; name: string; config: CampaignConfig | null }[];
  busy: boolean;
  perform: (body: unknown, message: string) => Promise<boolean>;
}) {
  const t = useT();
  const [draft, setDraft] = useState<ScheduleConfig>(
    schedule?.schedule_config ?? {
      search: {
        source: "google_maps",
        name: "",
        niche: "",
        location: "",
        limit: 20,
        budget_usd: 1,
        enrich: true,
      },
      interval_hours: 24,
      max_runs: 5,
      total_budget_usd: 5,
      campaign_config: null,
    },
  );
  const setSearch = (patch: Partial<ScheduleConfig["search"]>) =>
    setDraft((d) => ({ ...d, search: { ...d.search, ...patch } }));
  return (
    <details className="rounded-xl border p-5">
      <summary className="cursor-pointer font-medium">
        {t("Buscas automáticas")} · {schedule?.schedule_enabled ? t("Ativa") : t("Desligada")}
      </summary>
      <p className="mt-3 text-sm text-muted-foreground">
        {t(
          "Salve a configuração desligada. Ao ativar, o sistema repete as buscas e para no limite de execuções, no teto reservado, em falha ou quando não encontra novas empresas.",
        )}
      </p>
      {schedule?.schedule_config && (
        <p className="mt-2 text-sm">
          {schedule.schedule_runs} / {schedule.schedule_config.max_runs} · US${" "}
          {Number(schedule.schedule_reserved_usd).toFixed(2)} /{" "}
          {schedule.schedule_config.total_budget_usd.toFixed(2)} {t("de teto reservado")}
        </p>
      )}
      {schedule?.schedule_error && (
        <p role="status" className="mt-2 text-sm">
          {schedule.schedule_error}
        </p>
      )}
      {draft.search.source === "instagram" && (
        <p className="mt-2 text-sm text-muted-foreground">
          {t(
            "Busca perfis públicos por segmento e região, sem garantir localização. A abordagem usa WhatsApp quando há telefone público. O Instagram via Zernio não permite iniciar DM para perfis coletados; respostas e automações de comentários ficam na central do Instagram.",
          )}
        </p>
      )}
      <form
        className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={async (e) => {
          e.preventDefault();
          await perform(
            {
              action: "save_schedule",
              config: {
                ...draft,
                search: {
                  ...draft.search,
                  name: `${draft.search.niche} · ${draft.search.location}`.slice(0, 120),
                },
              },
            },
            t("Recorrência salva e desligada. Nenhuma busca foi iniciada."),
          );
        }}
      >
        <div>
          <Label htmlFor="schedule-source">{t("Fonte da recorrência")}</Label>
          <select
            id="schedule-source"
            className={selectClass}
            value={draft.search.source ?? "google_maps"}
            disabled={busy || schedule?.schedule_enabled}
            onChange={(e) => setSearch({ source: e.target.value as "google_maps" | "instagram" })}
          >
            <option value="google_maps">Google Maps</option>
            <option value="instagram">Instagram</option>
          </select>
        </div>
        <div>
          <Label htmlFor="schedule-niche">{t("Público da recorrência")}</Label>
          <Input
            id="schedule-niche"
            required
            minLength={2}
            maxLength={120}
            value={draft.search.niche}
            onChange={(e) => setSearch({ niche: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="schedule-location">{t("Região da recorrência")}</Label>
          <Input
            id="schedule-location"
            required
            minLength={2}
            maxLength={160}
            value={draft.search.location}
            onChange={(e) => setSearch({ location: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="schedule-hours">{t("Intervalo entre buscas (horas)")}</Label>
          <Input
            id="schedule-hours"
            type="number"
            required
            min={24}
            max={720}
            value={draft.interval_hours}
            onChange={(e) => setDraft((d) => ({ ...d, interval_hours: Number(e.target.value) }))}
          />
        </div>
        <div>
          <Label htmlFor="schedule-limit">{t("Empresas por busca")}</Label>
          <Input
            id="schedule-limit"
            type="number"
            required
            min={1}
            max={100}
            value={draft.search.limit}
            onChange={(e) => setSearch({ limit: Number(e.target.value) })}
          />
        </div>
        <div>
          <Label htmlFor="schedule-budget">{t("Teto por busca (US$)")}</Label>
          <Input
            id="schedule-budget"
            type="number"
            required
            min={0.5}
            max={10}
            step={0.01}
            value={draft.search.budget_usd}
            onChange={(e) => setSearch({ budget_usd: Number(e.target.value) })}
          />
        </div>
        <div>
          <Label htmlFor="schedule-runs">{t("Máximo de buscas")}</Label>
          <Input
            id="schedule-runs"
            type="number"
            required
            min={1}
            max={100}
            value={draft.max_runs}
            onChange={(e) => setDraft((d) => ({ ...d, max_runs: Number(e.target.value) }))}
          />
        </div>
        <div>
          <Label htmlFor="schedule-total">{t("Teto total da recorrência (US$)")}</Label>
          <Input
            id="schedule-total"
            type="number"
            required
            min={0.5}
            max={100}
            step={0.01}
            value={draft.total_budget_usd}
            onChange={(e) => setDraft((d) => ({ ...d, total_budget_usd: Number(e.target.value) }))}
          />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="schedule-outreach">{t("Abordagem após cada busca")}</Label>
          <select
            id="schedule-outreach"
            className={selectClass}
            value={
              draft.campaign_config
                ? (campaigns.find(
                    (c) => JSON.stringify(c.config) === JSON.stringify(draft.campaign_config),
                  )?.id ?? "saved")
                : ""
            }
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                campaign_config: campaigns.find((c) => c.id === e.target.value)?.config ?? null,
              }))
            }
          >
            <option value="">{t("Apenas coletar empresas")}</option>
            {draft.campaign_config && <option value="saved">{t("Configuração salva")}</option>}
            {campaigns
              .filter((c) => c.config)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </div>
        <p className="text-sm text-muted-foreground sm:col-span-2">
          {t(
            "Para abordar automaticamente, reutilize uma campanha configurada com agente, canal, funil e critérios. O modo de teste e as proteções do canal continuam valendo. Uma busca já solicitada pode concluir mesmo após parar.",
          )}
        </p>
        <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-4">
          <Button type="submit" variant="outline" disabled={busy || schedule?.schedule_enabled}>
            {t("Salvar recorrência desligada")}
          </Button>
          <Button
            type="button"
            disabled={busy || !schedule?.schedule_config || schedule?.schedule_enabled}
            onClick={() =>
              perform(
                { action: "enable_schedule" },
                t("Recorrência ativada. O próximo ciclo pode consumir saldo."),
              )
            }
          >
            {t("Ativar buscas automáticas")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !schedule?.schedule_enabled}
            onClick={() =>
              perform({ action: "stop_schedule" }, t("Recorrência parada e lote pausado."))
            }
          >
            {t("Parar recorrência")}
          </Button>
        </div>
      </form>
    </details>
  );
}
