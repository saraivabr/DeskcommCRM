"use client";
import { RefreshCw } from "lucide-react";
import { useT } from "@/hooks/i18n/useT";
import styles from "./workspace-home.module.css";

/**
 * A falha de "Precisa de você", com a ação no lugar onde se lê o problema.
 *
 * Sem `onRetry` não há botão: falha de autorização não se resolve repetindo,
 * e um botão que nunca funciona é pior que nenhum.
 */
export function PendingLoadError({
  message,
  onRetry,
  busy = false,
}: {
  message: string;
  onRetry?: () => void;
  busy?: boolean;
}) {
  const t = useT();
  return (
    <div role="alert" className={styles.loadError}>
      <p>
        <strong>{t("Não deu para ver o que espera por você.")}</strong>
        <span>{t(message)}</span>
      </p>
      {onRetry && (
        <button type="button" className={styles.retry} disabled={busy} onClick={onRetry}>
          <RefreshCw size={16} className={busy ? "animate-spin" : ""} aria-hidden />
          {t("Tentar de novo")}
        </button>
      )}
    </div>
  );
}
