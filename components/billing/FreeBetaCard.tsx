import type { Idioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";

export interface FreeBetaAccount {
  free_enabled: boolean;
  free_seats: number | null;
  free_channels: number | null;
  free_agents: number | null;
  free_ai_credit_cents: number | null;
  free_period_start: string | Date | null;
  free_period_end: string | Date | null;
}

export function FreeBetaCard({
  account,
  idioma,
  now,
}: {
  account: FreeBetaAccount;
  idioma: Idioma;
  now: number;
}) {
  const t = (text: string) => traduzir(text, idioma);
  const date = (value: string | Date) =>
    new Intl.DateTimeFormat(idioma, {
      dateStyle: "short",
      timeZone: "UTC",
    }).format(new Date(value));
  const start = account.free_period_start ? new Date(account.free_period_start).getTime() : NaN;
  const end = account.free_period_end ? new Date(account.free_period_end).getTime() : NaN;
  const configured =
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start < end &&
    account.free_seats !== null &&
    account.free_channels !== null &&
    account.free_agents !== null &&
    account.free_ai_credit_cents !== null &&
    account.free_ai_credit_cents > 0;
  const active = account.free_enabled && configured && start <= now && end > now;
  const message =
    !account.free_enabled || !configured
      ? t("Seu acesso Free beta aguarda liberação da administração.")
      : start > now
        ? t("Seu Free beta está programado e aguarda o início do período.")
        : end <= now
          ? t(
              "Seu período Free beta expirou. Solicite a renovação manual à administração para voltar a gerar.",
            )
          : t("Acesso gratuito de experimentação, com IA incluída.");
  return (
    <section className="space-y-3 rounded-2xl border bg-card p-5" aria-label={t("Seu Free beta")}>
      <h2 className="text-xl font-semibold">{t("Free beta")}</h2>
      <p role="status">{message}</p>
      <dl className="flex flex-wrap gap-6 text-sm">
        {(
          [
            [t("Pessoas na equipe"), account.free_seats],
            [t("Canais conectados"), account.free_channels],
            [t("Funcionários de IA publicados"), account.free_agents],
          ] as const
        ).map(([label, amount]) => (
          <div key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{amount ?? t("A definir")}</dd>
          </div>
        ))}
      </dl>
      {Number.isFinite(start) &&
        Number.isFinite(end) &&
        account.free_period_start &&
        account.free_period_end && (
          <p className="text-sm">
            {t("Período de experimentação:")} {date(account.free_period_start)} —{" "}
            {date(account.free_period_end)}
          </p>
        )}
      <p className="text-sm text-muted-foreground">
        {t(
          "Os limites são desta conta de teste. Confira abaixo a validade e o saldo disponível antes de gerar. Sem cobrança automática de excedente.",
        )}
      </p>
      {active && (
        <a className="text-sm underline" href="/app/instagram/new?first_post=1">
          {t("Criar minha primeira postagem")}
        </a>
      )}
    </section>
  );
}
