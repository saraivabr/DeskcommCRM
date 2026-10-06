import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({ read: vi.fn(), decrypt: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: doubles.read }) }) }),
  }),
}));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: doubles.decrypt }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

import {
  getPlatformMetaAppNative,
  invalidarAppDaMeta,
  platformMetaAppNativeDoAmbiente,
} from "@/lib/channels/meta/app";

const source = {
  META_APP_ID: "4407041089531183",
  META_BUSINESS_LOGIN_CONFIG_ID: "123456789012345",
  META_APP_SECRET: "secret-env-for-test-only",
  META_NATIVE_ENABLED: "true",
  META_INSTAGRAM_ENABLED: "true",
  META_ADS_ENABLED: "true",
};
const row = {
  app_id: "4407041089531183",
  config_id: "987654321012345",
  config_revision: 4,
  app_secret_encrypted: "encrypted-fixture",
  native_enabled: true,
  instagram_enabled: true,
  ads_enabled: false,
};
beforeEach(() => {
  invalidarAppDaMeta();
  doubles.read.mockReset().mockResolvedValue({ data: row, error: null });
  doubles.decrypt.mockReset().mockResolvedValue("secret-db-for-test-only");
  for (const [key, value] of Object.entries(source)) vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  invalidarAppDaMeta();
});

describe("configuração do login nativo Meta", () => {
  it("não remenda segredo do banco com ID/config do ambiente", async () => {
    const resolved = await getPlatformMetaAppNative();
    expect(resolved).toMatchObject({
      appId: row.app_id,
      configId: row.config_id,
      revision: 4,
      appSecret: "secret-db-for-test-only",
      nativeEnabled: true,
      adsEnabled: false,
    });
  });
  it("desabilitação explícita no banco vence ambiente habilitado", async () => {
    doubles.read.mockResolvedValue({ data: { ...row, native_enabled: false }, error: null });
    expect((await getPlatformMetaAppNative()).nativeEnabled).toBe(false);
  });
  it("cifra inválida fecha o login sem fallback para outro segredo", async () => {
    doubles.decrypt.mockResolvedValue(null);
    expect(await getPlatformMetaAppNative()).toMatchObject({
      appSecret: null,
      nativeEnabled: false,
    });
  });
  it("erro inesperado do banco fecha o login", async () => {
    doubles.read.mockResolvedValue({ data: null, error: { code: "08006" } });
    expect((await getPlatformMetaAppNative()).nativeEnabled).toBe(false);
  });
  it("schema legado fecha login mesmo com configuração completa no ambiente", async () => {
    doubles.read.mockResolvedValue({ data: null, error: { code: "42703" } });
    expect(await getPlatformMetaAppNative()).toMatchObject({
      appId: null,
      appSecret: null,
      nativeEnabled: false,
    });
  });
  it("sem snapshot persistido não emite autorização que o callback recusaria", async () => {
    doubles.read.mockResolvedValue({ data: null, error: null });
    expect((await getPlatformMetaAppNative()).nativeEnabled).toBe(false);
    invalidarAppDaMeta();
    doubles.read.mockResolvedValue({ data: { app_id: null, config_id: null }, error: null });
    expect((await getPlatformMetaAppNative()).nativeEnabled).toBe(false);
  });
  it("meia configuração do ambiente não habilita login", () => {
    expect(platformMetaAppNativeDoAmbiente({ ...source, META_APP_SECRET: "" })).toMatchObject({
      appSecret: null,
      nativeEnabled: false,
    });
    expect(
      platformMetaAppNativeDoAmbiente({ ...source, META_BUSINESS_LOGIN_CONFIG_ID: "bad" })
        .nativeEnabled,
    ).toBe(false);
  });
  it("rotação de segredo altera a revisão usada para vincular tentativas", () => {
    const original = platformMetaAppNativeDoAmbiente(source);
    expect(
      platformMetaAppNativeDoAmbiente({ ...source, META_APP_SECRET: "rotated-secret" }).revision,
    ).not.toBe(original.revision);
  });
  it("invalidar configuração força nova leitura, inclusive após desabilitar", async () => {
    await getPlatformMetaAppNative();
    await getPlatformMetaAppNative();
    expect(doubles.read).toHaveBeenCalledTimes(1);
    doubles.read.mockResolvedValue({ data: { ...row, native_enabled: false }, error: null });
    invalidarAppDaMeta();
    expect((await getPlatformMetaAppNative()).nativeEnabled).toBe(false);
    expect(doubles.read).toHaveBeenCalledTimes(2);
  });
});
