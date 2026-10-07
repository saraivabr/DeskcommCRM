"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { apiClient } from "@/lib/api/client";
import type {
  MetaCapabilities,
  MetaConnectionDTO,
  MetaStatusDTO,
  MetaAssetDTO,
} from "@/lib/channels/meta/social/types";

export type MetaNativeConnection = MetaConnectionDTO;
export type MetaNativeState = MetaStatusDTO;
export type MetaNativeAsset = MetaAssetDTO;

const API = "/api/v1/integrations/meta";
const statusLabels: Record<string, string> = {
  selection_pending: "Escolha as contas",
  healthy: "Autorização válida",
  token_expired: "Autorização expirada",
  scope_missing: "Permissão insuficiente",
  revoked: "Autorização retirada",
  disconnected: "Desconectada",
  error: "Precisa de atenção",
};
const returnErrors: Record<string, string> = {
  cancelled: "Você cancelou a autorização. Conecte novamente quando quiser continuar.",
  invalid_state:
    "Este retorno de autorização expirou ou não pertence a esta sessão. Conecte novamente.",
  config_changed: "A configuração da conexão mudou durante o login. Conecte novamente.",
  provider_error: "A Meta não concluiu a autorização. Conecte novamente e confira as permissões.",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Não foi possível concluir a conexão.";
}

function assetLabel(kind: MetaNativeAsset["kind"]): string {
  return kind === "instagram"
    ? "Instagram"
    : kind === "ad_account"
      ? "Conta de anúncios"
      : "Página do Facebook";
}

function availableActions(capabilities: MetaCapabilities): string[] {
  return [
    ...(capabilities.instagram_publish ? ["Publicar no Instagram"] : []),
    ...(capabilities.ads_read ? ["Consultar anúncios"] : []),
    ...(capabilities.ads_manage ? ["Gerenciar anúncios"] : []),
    ...(capabilities.instagram_message || capabilities.facebook_message
      ? ["Receber mensagens no atendimento"]
      : []),
  ];
}

interface MessagingState {
  channels: {
    id: string;
    asset_id: string;
    platform: "instagram" | "facebook";
    status: string;
    last_error: string | null;
  }[];
}

function MetaMessaging({
  connectionId,
  orgId,
  readonly,
  busy,
  processingAssetId,
  onChange,
  onReconnect,
}: {
  connectionId: string;
  orgId: string | undefined;
  readonly: boolean;
  busy: boolean;
  processingAssetId: string | null;
  onChange: (assetId: string, action: "enable" | "disable") => void;
  onReconnect: () => void;
}) {
  const t = useT();
  const assets = useQuery({
    queryKey: ["meta-native-assets", orgId, connectionId],
    queryFn: async () =>
      (
        await apiClient.get<{ data: { assets: MetaNativeAsset[] } }>(
          `${API}/assets?connection_id=${encodeURIComponent(connectionId)}`,
        )
      ).data,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const messaging = useQuery({
    queryKey: ["meta-native-messaging", orgId],
    queryFn: async () => {
      const response = await apiClient.get<{ data: MessagingState }>(`${API}/messaging`);
      if (!Array.isArray(response.data.channels))
        throw new Error("Não foi possível consultar os canais de atendimento.");
      return { channels: response.data.channels };
    },
    retry: false,
  });
  const selected = assets.data?.assets.filter(
    (asset) => asset.selected && (asset.kind === "page" || asset.kind === "instagram"),
  );
  return (
    <div className="mt-4 space-y-3 border-t pt-4">
      <h4 className="font-medium">{t("Mensagens no atendimento")}</h4>
      <p className="text-sm leading-6 text-muted-foreground">
        {t(
          "Receba mensagens do Instagram e do Facebook no Inbox e responda dentro da janela permitida pela Meta.",
        )}
      </p>
      {(assets.isPending || messaging.isPending) && (
        <p role="status">{t("Consultando canais de atendimento…")}</p>
      )}
      {(assets.error || messaging.error) && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            {t(errorMessage(assets.error ?? messaging.error))}
          </p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              void assets.refetch();
              void messaging.refetch();
            }}
          >
            {t("Consultar atendimento novamente")}
          </Button>
        </div>
      )}
      {assets.isSuccess &&
        messaging.isSuccess &&
        selected?.map((asset) => {
          const channel = messaging.data.channels.find((item) => item.asset_id === asset.id);
          const active = channel?.status === "WORKING";
          const permitted =
            asset.kind === "instagram"
              ? asset.capabilities.instagram_message === true
              : asset.capabilities.facebook_message === true;
          return (
            <div key={asset.id} className="space-y-2 rounded-lg border p-3">
              <p className="font-medium break-words">
                {t(assetLabel(asset.kind))} · {asset.name}
              </p>
              {active ? (
                <p className="text-sm text-muted-foreground">
                  {t("Recebimento habilitado. A primeira mensagem recebida aparecerá no Inbox.")}
                </p>
              ) : channel?.status === "STOPPED" ? (
                <p className="text-sm text-muted-foreground">
                  {t("Recebimento pausado. O histórico permanece no Inbox.")}
                </p>
              ) : channel ? (
                <p className="text-sm text-muted-foreground">
                  {t(
                    "O recebimento precisa de atenção. Consulte o erro e tente habilitar novamente.",
                  )}
                </p>
              ) : null}
              {channel?.last_error && (
                <p role="alert" className="text-sm text-destructive">
                  {t(channel.last_error)}
                </p>
              )}
              {!permitted && (
                <p className="text-sm text-muted-foreground">
                  {t(
                    "Permissão de mensagens não concedida para esta conta. Reconecte e autorize o atendimento.",
                  )}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={
                    t(active ? "Pausar recebimento" : "Receber no atendimento") + " " + asset.name
                  }
                  disabled={busy || readonly || (!active && !permitted)}
                  onClick={() => onChange(asset.id, active ? "disable" : "enable")}
                >
                  {t(active ? "Pausar recebimento" : "Receber no atendimento")}
                </Button>
                {!permitted && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || readonly}
                    onClick={onReconnect}
                  >
                    {t("Reconectar para autorizar mensagens")}
                  </Button>
                )}
                {channel && (
                  <Button asChild size="sm" variant="ghost">
                    <Link href="/app/inbox">{t("Abrir Inbox")}</Link>
                  </Button>
                )}
              </div>
              {processingAssetId === asset.id && (
                <p role="status" className="text-sm text-muted-foreground">
                  {t(active ? "Pausando recebimento…" : "Habilitando atendimento…")}
                </p>
              )}
            </div>
          );
        })}
      {assets.isSuccess && selected?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t("Escolha uma Página ou um Instagram para configurar o atendimento.")}
        </p>
      )}
    </div>
  );
}

function AssetSelectionForm({
  assets,
  readonly,
  busy,
  onSave,
  onClose,
}: {
  assets: MetaNativeAsset[];
  readonly: boolean;
  busy: boolean;
  onSave: (ids: string[]) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState(
    () => new Set(assets.filter((asset) => asset.selected).map((asset) => asset.id)),
  );
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!readonly && !busy) onSave([...selected]);
      }}
    >
      <fieldset disabled={readonly || busy} className="space-y-3">
        <legend className="mb-3 font-medium">
          {t("Escolha as contas que esta empresa poderá usar")}
        </legend>
        {assets.map((asset) => {
          const actions = availableActions(asset.capabilities);
          return (
            <label
              key={asset.id}
              className="flex cursor-pointer items-start gap-3 rounded-lg border p-4"
            >
              <input
                type="checkbox"
                className="mt-1 size-4 shrink-0 accent-primary"
                aria-label={t("Selecionar") + " " + asset.name}
                checked={selected.has(asset.id)}
                onChange={(event) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(asset.id);
                    else next.delete(asset.id);
                    return next;
                  })
                }
              />
              <span className="min-w-0 space-y-2">
                <span className="block text-xs text-muted-foreground">
                  {t(assetLabel(asset.kind))}
                </span>
                <span className="block font-medium break-words">
                  {asset.name}
                  {asset.username ? ` · @${asset.username.replace(/^@/, "")}` : ""}
                </span>
                {(asset.currency || asset.timezone) && (
                  <span className="block text-xs text-muted-foreground">
                    {[asset.currency, asset.timezone].filter(Boolean).join(" · ")}
                  </span>
                )}
                {actions.length > 0 ? (
                  <span className="flex flex-wrap gap-2">
                    {actions.map((action) => (
                      <Badge key={action} variant="secondary">
                        {t(action)}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  <span className="block text-sm text-muted-foreground">
                    {t("Sem ações autorizadas para esta conta.")}
                  </span>
                )}
                {asset.unavailable_reason && (
                  <span className="block text-sm text-muted-foreground">
                    {t(asset.unavailable_reason)}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </fieldset>
      <p className="text-xs leading-6 text-muted-foreground">
        {t("As permissões podem variar entre contas. Conectar não publica nem ativa anúncios.")}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={readonly || busy}>
          {busy ? t("Salvando…") : t("Salvar contas escolhidas")}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
          {t("Cancelar")}
        </Button>
      </div>
    </form>
  );
}

function AssetSelection({
  connectionId,
  orgId,
  readonly,
  busy,
  onSave,
  onClose,
}: {
  connectionId: string;
  orgId: string | undefined;
  readonly: boolean;
  busy: boolean;
  onSave: (ids: string[]) => void;
  onClose: () => void;
}) {
  const t = useT();
  const assetsQuery = useQuery({
    queryKey: ["meta-native-assets", orgId, connectionId],
    queryFn: async () =>
      (
        await apiClient.get<{ data: { assets: MetaNativeAsset[] } }>(
          `${API}/assets?connection_id=${encodeURIComponent(connectionId)}`,
        )
      ).data,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return (
    <div className="mt-4 border-t pt-4">
      {assetsQuery.isPending && <p role="status">{t("Buscando suas contas…")}</p>}
      {assetsQuery.error && (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-destructive">
            {t(errorMessage(assetsQuery.error))}
          </p>
          <Button variant="outline" onClick={() => void assetsQuery.refetch()}>
            {t("Buscar novamente")}
          </Button>
        </div>
      )}
      {assetsQuery.data?.assets.length === 0 && (
        <div className="space-y-3">
          <p>{t("Nenhuma conta disponível nesta autorização.")}</p>
          <p className="text-sm text-muted-foreground">
            {t(
              "Confira na Meta se você administra a Página, o Instagram profissional ou a conta de anúncios. Depois, reconecte e permita o acesso às contas desejadas.",
            )}
          </p>
          <Button variant="ghost" onClick={onClose}>
            {t("Fechar")}
          </Button>
        </div>
      )}
      {assetsQuery.data && assetsQuery.data.assets.length > 0 && (
        <AssetSelectionForm
          key={assetsQuery.dataUpdatedAt}
          assets={assetsQuery.data.assets}
          readonly={readonly}
          busy={busy}
          onSave={onSave}
          onClose={onClose}
        />
      )}
    </div>
  );
}

export function MetaNativeClient() {
  const t = useT();
  const languageTag = useTagDeIdioma();
  const params = useSearchParams();
  const orgId = useActiveOrg()?.orgId;
  const readonly = useUser().support?.access_mode === "support_readonly";
  const client = useQueryClient();
  const queryKey = ["meta-native-connections", orgId];
  const query = useQuery({
    queryKey,
    queryFn: async () => (await apiClient.get<{ data: MetaNativeState }>(API)).data,
    retry: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<MetaNativeConnection | null>(null);
  const inFlight = useRef(false);
  const handledReturn = useRef<string | null>(null);
  const ticket = params.get("meta_ticket");
  const returnError = params.get("meta_error");
  const { mutate: finalize, isPending: finalizing } = useMutation({
    mutationFn: async (result: { ticket: string | null; error: string | null }) => {
      if (result.error) throw new Error(returnErrors[result.error] ?? returnErrors.provider_error);
      if (readonly)
        throw new Error(
          "Seu acesso de suporte permite apenas consultar. A pessoa que administra precisa concluir a autorização.",
        );
      await apiClient.post(`${API}/finalize`, { ticket: result.ticket });
    },
    retry: false,
    onSuccess: async () => {
      setNotice("Autorização recebida. Escolha as contas que sua empresa vai usar.");
      await client.invalidateQueries({ queryKey: ["meta-native-connections", orgId] });
    },
    onError: (failure) => setError(errorMessage(failure)),
  });

  useEffect(() => {
    const returnKey = ticket ?? returnError;
    if (!returnKey || handledReturn.current === returnKey) return;
    handledReturn.current = returnKey;
    // O ticket é opaco e de uso único. Sai do histórico antes de qualquer
    // chamada para não seguir em links copiados ou no referer da navegação.
    const url = new URL(window.location.href);
    url.searchParams.delete("meta_ticket");
    url.searchParams.delete("meta_error");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
    finalize({ ticket, error: returnError });
  }, [ticket, returnError, finalize]);

  const working = !!busy || finalizing;
  const state = query.data;
  async function perform(id: string, action: () => Promise<void>) {
    if (inFlight.current || finalizing) return;
    inFlight.current = true;
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }
  const start = () =>
    perform("start", async () => {
      if (readonly || !state?.configured) return;
      const response = await apiClient.post<{ data: { authorization_url: string } }>(
        `${API}/start`,
        {},
      );
      const url = new URL(response.data.authorization_url);
      if (url.protocol !== "https:")
        throw new Error(
          "Não foi possível abrir a autorização. Peça à equipe responsável para revisar a conexão.",
        );
      window.location.assign(url.toString());
    });
  const saveAssets = (connectionId: string, ids: string[]) =>
    perform("assets", async () => {
      if (readonly) return;
      await apiClient.post(`${API}/assets`, { connection_id: connectionId, asset_ids: ids });
      await client.invalidateQueries({ queryKey: ["meta-native-assets", orgId, connectionId] });
      await query.refetch();
      setEditing(null);
      setNotice("Contas escolhidas salvas.");
    });
  const verify = (connectionId: string) =>
    perform(`health:${connectionId}`, async () => {
      if (readonly) return;
      const response = await apiClient.post<{ data: MetaNativeState }>(`${API}/health`, {
        connection_id: connectionId,
      });
      client.setQueryData(queryKey, response.data);
      await client.invalidateQueries({ queryKey: ["meta-native-assets", orgId, connectionId] });
      const checked = response.data.connections.find(
        (connection) => connection.id === connectionId,
      );
      if (!checked)
        throw new Error("Não foi possível confirmar o estado desta autorização. Atualize a lista.");
      if (checked.reconnect_required && editing === connectionId) setEditing(null);
      setNotice(
        checked.status === "healthy"
          ? "Verificação concluída. A autorização continua válida; confira as permissões de cada conta."
          : "Verificação concluída. Esta autorização precisa de atenção; confira o estado e reconecte quando solicitado.",
      );
    });
  const changeMessaging = (assetId: string, action: "enable" | "disable") =>
    perform(`messaging:${assetId}`, async () => {
      if (readonly) return;
      const response = await apiClient.post<{ data: MessagingState }>(`${API}/messaging`, {
        action,
        asset_id: assetId,
      });
      const channel = response.data.channels?.find((item) => item.asset_id === assetId);
      if (!channel || channel.status !== (action === "enable" ? "WORKING" : "STOPPED")) {
        await client.invalidateQueries({ queryKey: ["meta-native-messaging", orgId] });
        throw new Error(
          "Não foi possível confirmar o recebimento. Atualize o estado antes de tentar novamente.",
        );
      }
      client.setQueryData(["meta-native-messaging", orgId], { channels: response.data.channels });
      await client.invalidateQueries({ queryKey: ["channel-sessions"] });
      setNotice(
        action === "enable"
          ? "Recebimento habilitado. A primeira mensagem recebida aparecerá no Inbox."
          : "Recebimento pausado. O histórico permanece no Inbox.",
      );
    });

  return (
    <section aria-labelledby="meta-native-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="max-w-xl space-y-2">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t("Conexão direta com a Meta")}
          </p>
          <h2 id="meta-native-heading" className="text-xl font-semibold tracking-tight">
            {t("Seu Instagram e seus anúncios, aqui")}
          </h2>
          <p className="text-sm leading-6 text-muted-foreground">
            {t(
              "Autorize suas contas na Meta e escolha quais sua empresa vai usar para publicar e acompanhar campanhas.",
            )}
          </p>
        </div>
        <Button
          disabled={working || readonly || !state?.configured || query.isError}
          onClick={() => void start()}
        >
          {busy === "start" ? t("Abrindo autorização…") : t("Conectar Facebook e Instagram")}
        </Button>
      </div>
      {readonly && (
        <p className="text-sm text-muted-foreground">
          {t(
            "Seu acesso de suporte permite apenas consultar. A pessoa que administra precisa autorizar ou alterar as contas.",
          )}
        </p>
      )}
      {finalizing && <p role="status">{t("Confirmando sua sessão e autorização…")}</p>}
      {notice && (
        <p
          role="status"
          aria-label={t("Resultado da conexão")}
          className="rounded-lg border bg-muted/30 p-4 text-sm"
        >
          {t(notice)}
        </p>
      )}
      {((error && !disconnecting) || query.error) && (
        <div className="space-y-3">
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 p-4 text-sm text-destructive"
          >
            {t(error ?? errorMessage(query.error))}
          </p>
          {query.error && (
            <Button variant="outline" disabled={working} onClick={() => void query.refetch()}>
              {t("Tentar novamente")}
            </Button>
          )}
        </div>
      )}
      {query.isPending && <p role="status">{t("Carregando conexões…")}</p>}
      {state && !state.configured && (
        <Card className="space-y-2 p-5">
          <h3 className="font-medium">{t("Conexão ainda indisponível")}</h3>
          <p className="text-sm leading-6 text-muted-foreground">
            {t(
              "A equipe responsável precisa preparar a conexão com a Meta. Suas conexões sociais existentes continuam disponíveis abaixo.",
            )}
          </p>
        </Card>
      )}
      {state?.configured && state.connections.length === 0 && (
        <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
          {t("Nenhuma conta conectada.")} {t("Comece autorizando sua conta na Meta.")}
        </p>
      )}
      {state?.connections.map((connection) => {
        const name = connection.actor_name || t("Conta Meta");
        const disconnected =
          connection.status === "disconnected" || connection.status === "revoked";
        const reconnect = disconnected || connection.reconnect_required;
        return (
          <Card key={connection.id} className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 space-y-2">
                <h3 className="font-semibold break-words">{name}</h3>
                <Badge variant={connection.status === "healthy" ? "secondary" : "outline"}>
                  {t(statusLabels[connection.status] ?? "Precisa de atenção")}
                </Badge>
                <p className="text-sm text-muted-foreground">
                  {connection.selected_asset_count}{" "}
                  {t(
                    connection.selected_asset_count === 1 ? "conta escolhida" : "contas escolhidas",
                  )}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {reconnect ? (
                  <Button
                    variant="outline"
                    aria-label={t("Reconectar") + " " + name}
                    disabled={working || readonly || !state.configured}
                    onClick={() => void start()}
                  >
                    {t("Reconectar")}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    disabled={working}
                    onClick={() => setEditing(editing === connection.id ? null : connection.id)}
                  >
                    {t(connection.selected_asset_count > 0 ? "Revisar contas" : "Escolher contas")}
                  </Button>
                )}
                {!disconnected && (
                  <Button
                    variant="ghost"
                    disabled={working || readonly}
                    aria-label={t("Desconectar") + " " + name}
                    onClick={() => setDisconnecting(connection)}
                  >
                    {t("Desconectar")}
                  </Button>
                )}
              </div>
            </div>
            {reconnect && (
              <p className="mt-4 text-sm leading-6 text-muted-foreground">
                {t(
                  "Reconecte para atualizar as permissões. As ações desta autorização ficam indisponíveis até a confirmação.",
                )}
              </p>
            )}
            {connection.expires_at && (
              <p className="mt-3 text-xs text-muted-foreground">
                {t("Validade informada pela Meta:")}{" "}
                {new Date(connection.expires_at).toLocaleDateString(languageTag, {
                  timeZone: "UTC",
                })}
              </p>
            )}
            {connection.checked_at && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t("Última verificação na Meta:")}{" "}
                {new Date(connection.checked_at).toLocaleString(languageTag)}
              </p>
            )}
            {!disconnected && (
              <Button
                className="mt-3"
                size="sm"
                variant="ghost"
                disabled={working || readonly || !state.configured}
                aria-label={t("Verificar conexão") + " " + name}
                onClick={() => void verify(connection.id)}
              >
                {busy === `health:${connection.id}` ? t("Verificando…") : t("Verificar conexão")}
              </Button>
            )}
            {editing === connection.id && !reconnect && (
              <AssetSelection
                connectionId={connection.id}
                orgId={orgId}
                readonly={readonly}
                busy={working}
                onSave={(ids) => void saveAssets(connection.id, ids)}
                onClose={() => setEditing(null)}
              />
            )}
            {!reconnect && connection.selected_asset_count > 0 && (
              <MetaMessaging
                connectionId={connection.id}
                orgId={orgId}
                readonly={readonly}
                busy={working}
                processingAssetId={
                  busy?.startsWith("messaging:") ? busy.slice("messaging:".length) : null
                }
                onChange={(assetId, action) => void changeMessaging(assetId, action)}
                onReconnect={() => void start()}
              />
            )}
          </Card>
        );
      })}
      {state && (
        <Button
          className="self-start"
          variant="ghost"
          disabled={working || query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? t("Atualizando…") : t("Atualizar estado")}
        </Button>
      )}
      <AlertDialog
        open={!!disconnecting}
        onOpenChange={(open) => {
          if (!open && !working) setDisconnecting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Desconectar esta autorização?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "As contas desta autorização deixam de executar novas ações aqui. O histórico permanece. Publicações e anúncios já existentes continuam na Meta.",
              )}
            </AlertDialogDescription>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {t(error)}
              </p>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={working || readonly}
              onClick={(event) => {
                event.preventDefault();
                if (!disconnecting) return;
                void perform("disconnect", async () => {
                  await apiClient.post(`${API}/disconnect`, { connection_id: disconnecting.id });
                  setDisconnecting(null);
                  setEditing(null);
                  await client.invalidateQueries({ queryKey: ["meta-native-assets", orgId] });
                  await query.refetch();
                  setNotice("Autorização desconectada. O histórico foi preservado.");
                });
              }}
            >
              {busy === "disconnect" ? t("Desconectando…") : t("Desconectar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
