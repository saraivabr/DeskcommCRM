"use client";
import { useEffect, useState } from "react";
import { LinkDeNavegacao } from "@/components/shell/LinkDeNavegacao";
import { ArrowRight, RefreshCw } from "lucide-react";
import { useT } from "@/hooks/i18n/useT";
import styles from "./workspace-home.module.css";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import type { HomeInput, HomeOverview } from "@/lib/workspace/home";
import { PendingLoadError } from "./PendingLoadError";

const priority = ["tasks", "agent-cases", "leads", "conversations"];
const FALHA_DE_CONEXAO = { message: "A conexão falhou. Tente de novo.", retryable: true };

export function WorkspaceOverview() {
  const t = useT();
  const [scope, setScope] = useState<HomeInput["scope"]>("mine");
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<HomeOverview | null>(null);
  // `retryable` decide o botão: repetir resolve rede, não sessão sem permissão.
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    // GET cancelável: uma consulta presa não segura o retry na fila de Actions.
    // O prazo da tela também descarta respostas atrasadas da tentativa anterior.
    const timeout = window.setTimeout(() => {
      if (!current) return;
      current = false;
      controller.abort();
      setData(null);
      setError(FALHA_DE_CONEXAO);
      setBusy(false);
    }, 20_000);
    void apiClient
      .get<{ data: HomeOverview }>(`/api/v1/workspace/home?scope=${scope}&days=7`, {
        signal: controller.signal,
        timeoutMs: 20_000,
      })
      .then(({ data: result }) => {
        if (!current) return;
        setData(result);
      })
      .catch((cause: unknown) => {
        if (current) {
          setData(null);
          setError(
            cause instanceof ApiError && cause.status === 401
              ? {
                  message:
                    "Não foi possível autorizar esta consulta. Confira sua sessão e suas permissões.",
                  retryable: false,
                }
              : FALHA_DE_CONEXAO,
          );
        }
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (current) setBusy(false);
      });
    return () => {
      current = false;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [scope, revision]);
  const reload = () => {
    setBusy(true);
    setError(null);
    setRevision((value) => value + 1);
  };
  const pendentes = data?.attention
    .filter((item) => item.count === null || item.count > 0)
    .sort((a, b) => priority.indexOf(a.id) - priority.indexOf(b.id));
  // Sem cards de número, filtros de período nem painéis: a Início mostra só o
  // que espera por você, em frases, e some quando não há nada.
  return (
    <section className={styles.pending} aria-busy={busy} aria-labelledby="home-attention-title">
      <div className={styles.pendingHead}>
        <h2 id="home-attention-title">{t("Precisa de você")}</h2>
        <div className={styles.scopeControls}>
          {data?.canSeeTeam && (
            <select
              aria-label={t("Escopo das pendências")}
              value={scope}
              disabled={busy}
              className={styles.period}
              onChange={(event) => {
                setBusy(true);
                setError(null);
                setScope(event.target.value as HomeInput["scope"]);
              }}
            >
              <option value="mine">{t("Minhas pendências")}</option>
              <option value="team">{t("Ver a equipe")}</option>
            </select>
          )}
          <button
            type="button"
            className={styles.refresh}
            disabled={busy}
            aria-label={t("Atualizar operação")}
            onClick={reload}
          >
            <RefreshCw size={16} className={busy ? "animate-spin" : ""} aria-hidden />
          </button>
        </div>
      </div>
      <p role="status" className={styles.loadStatus}>
        {busy ? t(data ? "Atualizando…" : "Olhando suas conversas…") : "\u00a0"}
      </p>
      {error && (
        <PendingLoadError
          message={error.message}
          busy={busy}
          onRetry={error.retryable ? reload : undefined}
        />
      )}
      {data &&
        (pendentes && pendentes.length > 0 ? (
          <div className={styles.pendingList}>
            {pendentes.map((item) => (
              <LinkDeNavegacao
                key={item.id}
                href={item.href}
                className={styles.pendingRow}
                data-kind={item.id}
                title={t(item.description)}
              >
                <strong>{item.count ?? "—"}</strong>
                <span>{t(item.label)}</span>
                <ArrowRight size={22} aria-hidden />
                {item.count === null && (
                  <span className="sr-only">
                    {t("Não foi possível consultar. Atualize para tentar novamente.")}
                  </span>
                )}
              </LinkDeNavegacao>
            ))}
          </div>
        ) : (
          <p className={styles.allClear}>{t("Tudo em dia. Nada esperando você.")}</p>
        ))}
    </section>
  );
}
