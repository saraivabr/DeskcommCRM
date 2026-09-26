"use client";
import { useEffect, useState } from "react";
type Approval = {
  id: string;
  label: string;
  resource_title: string;
  args: { id: string; expected_revision: number };
  status: string;
  expires_at: string;
};
type Connection = { id: string; name: string; revoked_at: string | null };
export function ConnectionsClient({ endpoint }: { endpoint: string }) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [organization, setOrganization] = useState("");
  const [role, setRole] = useState("viewer");
  const [name, setName] = useState("Minha IA");
  const [knowledgeRead, setKnowledgeRead] = useState(true);
  const [whatsapp, setWhatsapp] = useState(false);
  const [sendWhatsapp, setSendWhatsapp] = useState(false);
  const [crm, setCrm] = useState(false);
  const [write, setWrite] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [oauth, setOauth] = useState<Record<string, string> | null>(null);
  async function reload() {
    const response = await fetch("/api/v1/mcp/connections");
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message);
    setConnections(body.data.connections);
    setOrganization(body.data.organization);
    setRole(body.data.role);
    const pending = await fetch("/api/v1/mcp/approvals");
    if (!pending.ok) throw new Error("Não foi possível carregar confirmações.");
    setApprovals((await pending.json()).data.approvals);
  }
  useEffect(() => {
    void reload().catch((e) => setError(e.message));
    const params = Object.fromEntries(new URLSearchParams(window.location.search));
    if (params.client_id) {
      setOauth(params);
      setKnowledgeRead(params.scope?.split(" ").includes("knowledge:read") ?? false);
    }
  }, []);
  async function connect() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/v1/mcp/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          scopes: [
            ...(knowledgeRead ? ["knowledge:read"] : []),
            ...(write ? ["knowledge:write"] : []),
            ...(whatsapp ? ["whatsapp:read"] : []),
            ...(sendWhatsapp ? ["whatsapp:execute"] : []),
            ...(crm ? ["crm:read"] : []),
          ],
          ...(oauth ? { oauth } : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message);
      if (body.data.redirect) {
        window.location.assign(body.data.redirect);
        return;
      }
      setToken(body.data.token);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    try {
      const response = await fetch(`/api/v1/mcp/connections?id=${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Não foi possível revogar.");
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function decide(id: string, approve: boolean) {
    try {
      const response = await fetch("/api/v1/mcp/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, approve }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <main className="max-w-3xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">Conectar minha IA</h1>
      {approvals.length > 0 && (
        <section className="space-y-3" aria-label="Confirmar operações">
          <h2 className="font-semibold">Operações que precisam de você</h2>
          {approvals.map((action) => (
            <div className="space-y-2 rounded border p-4" key={action.id}>
              <p>
                {action.label}: <strong>{action.resource_title}</strong>
              </p>
              <p>
                Revisão {action.args.expected_revision} ·{" "}
                {action.status === "pending"
                  ? "Aguardando sua decisão"
                  : action.status === "approved"
                    ? "Aprovada. Sua IA pode repetir a operação."
                    : "Consulte o estado da página antes de tentar outra operação."}
              </p>
              <a className="underline" href={`/app/knowledge?page=${action.args.id}`}>
                Revisar página
              </a>
              {action.status === "pending" && (
                <div className="flex gap-4">
                  <button onClick={() => void decide(action.id, true)}>Aprovar operação</button>
                  <button onClick={() => void decide(action.id, false)}>Recusar</button>
                </div>
              )}
            </div>
          ))}
        </section>
      )}
      <p>
        Organização: <strong>{organization}</strong>. Use o seletor de organização do aplicativo
        para escolher outra antes de autorizar.
      </p>
      <p>
        Consulte e edite conhecimento, leia conversas do WhatsApp e consulte contatos, leads e
        funis. As outras operações estão em desenvolvimento.
      </p>
      <p>
        Endereço MCP: <code>{endpoint}</code>
      </p>
      {error && <p role="alert">{error}</p>}
      {oauth && (
        <p>
          Endereço de retorno do aplicativo solicitante:{" "}
          <code className="break-all">{oauth.redirect_uri}</code>. Confirme que pertence à IA que
          você está conectando.
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
        className="space-y-4 rounded border p-4"
      >
        <label className="block">
          Nome da conexão
          <input
            className="ml-3 rounded border p-2"
            value={name}
            maxLength={100}
            required
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {(!oauth || oauth.scope?.split(" ").includes("knowledge:read")) && (
          <label className="block">
            <input
              type="checkbox"
              checked={knowledgeRead}
              onChange={(e) => setKnowledgeRead(e.target.checked)}
            />{" "}
            Consultar páginas e pesquisar conhecimento
          </label>
        )}
        {role !== "viewer" && (!oauth || oauth.scope?.split(" ").includes("whatsapp:read")) && (
          <label className="block">
            <input
              type="checkbox"
              checked={whatsapp}
              onChange={(e) => setWhatsapp(e.target.checked)}
            />{" "}
            Consultar conversas e histórico do WhatsApp
          </label>
        )}
        {role !== "viewer" && (!oauth || oauth.scope?.split(" ").includes("whatsapp:execute")) && (
          <label className="block">
            <input
              type="checkbox"
              checked={sendWhatsapp}
              onChange={(e) => setSendWhatsapp(e.target.checked)}
            />{" "}
            Enviar mensagens pelo WhatsApp nas conversas que posso acessar
          </label>
        )}
        {role !== "viewer" && (!oauth || oauth.scope?.split(" ").includes("crm:read")) && (
          <label className="block">
            <input type="checkbox" checked={crm} onChange={(e) => setCrm(e.target.checked)} />{" "}
            Consultar contatos, leads e funis do CRM
          </label>
        )}
        {role !== "viewer" && (!oauth || oauth.scope?.split(" ").includes("knowledge:write")) && (
          <label className="block">
            <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} />{" "}
            Permitir criar e editar páginas
          </label>
        )}
        <button className="rounded bg-primary px-4 py-2 text-primary-foreground" disabled={busy}>
          {busy ? "Conectando…" : oauth ? "Autorizar acesso" : "Gerar token"}
        </button>
      </form>
      {token && (
        <div className="space-y-2 rounded border p-4">
          <p>Copie este token agora. Ele não será exibido novamente e expira em 90 dias.</p>
          <input
            aria-label="Token de conexão"
            className="w-full font-mono"
            readOnly
            value={token}
          />
          <button
            onClick={() =>
              void navigator.clipboard
                .writeText(token)
                .catch(() => setError("Selecione e copie o token manualmente."))
            }
          >
            Copiar token
          </button>
        </div>
      )}
      <h2 className="text-lg font-semibold">Minhas conexões</h2>
      {connections.map((c) => (
        <div className="flex justify-between border-b py-3" key={c.id}>
          <span>
            {c.name}
            {c.revoked_at ? " · Revogada" : ""}
          </span>
          {!c.revoked_at && <button onClick={() => void revoke(c.id)}>Revogar acesso</button>}
        </div>
      ))}
    </main>
  );
}
