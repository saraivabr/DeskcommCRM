import type { MetaAssetKind, MetaCapabilities, MetaGranularScope, MetaNativeApp } from "./types";

const NONE: MetaCapabilities = { ads_read: false, ads_manage: false, instagram_publish: false };
export function capabilityFlags(app: MetaNativeApp): MetaCapabilities {
  return app.nativeEnabled
    ? {
        ads_read: app.adsEnabled,
        ads_manage: app.adsEnabled,
        instagram_publish: app.instagramEnabled,
      }
    : { ...NONE };
}
export function tokenExpired(
  tokenExpiresAt: string | null,
  dataExpiresAt: string | null,
  now = Date.now(),
): boolean {
  return [tokenExpiresAt, dataExpiresAt].some(
    (v) => v !== null && (!Number.isFinite(Date.parse(v)) || Date.parse(v) <= now),
  );
}

export function assetCapabilities(input: {
  app: MetaNativeApp;
  kind: MetaAssetKind;
  externalId: string;
  parentPageExternalId?: string | null;
  scopes: readonly string[];
  permissions: readonly string[];
  granularScopes: readonly MetaGranularScope[];
  tasks: readonly string[];
  active: boolean;
  accountStatus?: number;
}): { capabilities: MetaCapabilities; unavailable_reason: string | null } {
  if (!input.active)
    return {
      capabilities: { ...NONE },
      unavailable_reason: "Reconecte para renovar a autorização deste ativo.",
    };
  if (!input.app.nativeEnabled)
    return {
      capabilities: { ...NONE },
      unavailable_reason: "A integração está desativada nesta instalação.",
    };
  const enabled = capabilityFlags(input.app);
  const hasScope = (scope: string): boolean => {
    if (!input.scopes.includes(scope) || !input.permissions.includes(scope)) return false;
    const granular = input.granularScopes.filter((g) => g.scope === scope);
    if (!granular.length) return true;
    return granular.some(
      (g) =>
        g.target_ids === undefined ||
        g.target_ids.some(
          (id) =>
            id.replace(/^act_/, "") === input.externalId.replace(/^act_/, "") ||
            id === input.parentPageExternalId,
        ),
    );
  };
  const managesAds = input.tasks.some((task) => ["ADVERTISE", "MANAGE", "ADMIN"].includes(task));
  const readsAds = managesAds || input.tasks.includes("ANALYZE");
  const posts = input.tasks.some((task) =>
    ["CREATE_CONTENT", "MANAGE", "PROFILE_PLUS_CREATE_CONTENT"].includes(task),
  );
  const capabilities = {
    ads_read:
      input.kind === "ad_account" &&
      enabled.ads_read &&
      readsAds &&
      (hasScope("ads_read") || hasScope("ads_management")),
    ads_manage:
      input.kind === "ad_account" &&
      enabled.ads_manage &&
      managesAds &&
      hasScope("ads_management") &&
      input.accountStatus === 1,
    instagram_publish:
      input.kind === "instagram" &&
      enabled.instagram_publish &&
      Boolean(input.parentPageExternalId) &&
      posts &&
      hasScope("instagram_basic") &&
      hasScope("instagram_content_publish") &&
      hasScope("pages_read_engagement"),
  };
  const any = Object.values(capabilities).some(Boolean);
  return {
    capabilities,
    unavailable_reason:
      any || input.kind === "page"
        ? null
        : "Faltam permissões ou tarefas neste ativo. Reautorize com acesso suficiente.",
  };
}
