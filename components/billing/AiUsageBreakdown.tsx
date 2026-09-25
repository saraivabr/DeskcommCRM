import type { readAiUsageBreakdown } from "@/lib/billing/ai-allowance-view";
import { formatBRL } from "@/lib/billing/plans";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

type Usage = Awaited<ReturnType<typeof readAiUsageBreakdown>>;
const labels = {
  text: "Texto",
  image: "Imagens",
  voice: "Voz",
  other: "Outras operações",
} as const;
export function AiUsageBreakdown({ usage, idioma }: { usage: Usage; idioma: Idioma }) {
  const t = (text: string) => traduzir(text, idioma);
  return (
    <section
      className="space-y-4 rounded-2xl border bg-card p-5"
      aria-label={t("Consumo de IA neste período")}
    >
      <h2 className="font-semibold">{t("Consumo de IA neste período")}</h2>
      {usage.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("Nenhuma operação registrada neste período.")}
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-3">
          {usage.map((row) => (
            <li key={row.kind} className="space-y-1">
              <h3 className="font-medium">{t(labels[row.kind])}</h3>
              <p className="text-sm">
                {row.operations} {t("operações registradas")}
              </p>
              <p className="text-sm">
                {formatBRL(row.commercialUsedBrlCents)} {t("utilizados")}
              </p>
              <p className="text-sm text-muted-foreground">
                {formatBRL(row.reservedBrlCents)} {t("reservados")}
              </p>
              {row.pendingOperations > 0 && (
                <p className="text-sm">
                  {row.pendingOperations} {t("operações aguardando confirmação do consumo")}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        {t(
          "Operações medem uso de IA; não equivalem a postagens, mensagens ou minutos entregues. Todas descontam do mesmo saldo, sem franquias separadas por recurso.",
        )}
      </p>
    </section>
  );
}
