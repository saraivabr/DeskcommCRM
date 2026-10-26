// Harness de fixtures: o componente real (`PendingLoadError`) dentro da moldura
// da seção "Precisa de você", em cada estado do PRD. `workspace-shell` liga os
// tokens da casca (verde de sinal, tinta, linhas) como no app.
import type { ReactNode } from "react";
import { PendingLoadError } from "@/app/app/_components/PendingLoadError";
import styles from "@/app/app/_components/workspace-home.module.css";

const noop = () => {};

function Moldura({ width, children }: { width: number; children: ReactNode }) {
  return (
    <div className="workspace-shell" style={{ width, padding: 24, background: "var(--background)" }}>
      <section className={styles.pending} style={{ marginTop: 0 }}>
        <div className={styles.pendingHead}>
          <h2>Precisa de você</h2>
        </div>
        {children}
      </section>
    </div>
  );
}

export function FalhaDeConexao() {
  return (
    <Moldura width={760}>
      <PendingLoadError message="A conexão falhou. Tente de novo." onRetry={noop} />
    </Moldura>
  );
}

export function Tentando() {
  return (
    <Moldura width={760}>
      <PendingLoadError message="A conexão falhou. Tente de novo." onRetry={noop} busy />
    </Moldura>
  );
}

export function FalhaDeAutorizacao() {
  return (
    <Moldura width={760}>
      <PendingLoadError message="Não foi possível autorizar esta consulta. Confira sua sessão e suas permissões." />
    </Moldura>
  );
}

export function Mobile() {
  return (
    <Moldura width={375}>
      <PendingLoadError message="A conexão falhou. Tente de novo." onRetry={noop} />
    </Moldura>
  );
}
