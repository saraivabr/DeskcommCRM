import { beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({
  auth: vi.fn(),
  support: vi.fn(),
  headers: vi.fn(),
  rpc: vi.fn(),
  encrypt: vi.fn(),
  audit: vi.fn(),
  invalidate: vi.fn(),
  mfa: vi.fn(),
}));
vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: doubles.auth }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: doubles.mfa }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://app.test" } }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: doubles.support }));
vi.mock("next/headers", () => ({ headers: doubles.headers }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: doubles.rpc }) }));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: doubles.encrypt }));
vi.mock("@/lib/audit", () => ({ audit: doubles.audit }));
vi.mock("@/lib/channels/meta/app", () => ({ invalidarAppDaMeta: doubles.invalidate }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));

import {
  updateMetaNativeConfiguration,
  updateMetaApp,
  rotacionarVerifyTokenDaMeta,
} from "@/app/actions/settings/updateMetaApp";

const input = {
  app_id: "4407041089531183",
  config_id: "123456789012345",
  expected_revision: 4,
  native_enabled: true,
  instagram_enabled: true,
  ads_enabled: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.test");
  doubles.auth.mockResolvedValue({ user: { id: "actor" }, platformAdmin: { scope: "full" } });
  doubles.support.mockResolvedValue(null);
  doubles.mfa.mockResolvedValue(false);
  doubles.headers.mockResolvedValue(new Headers({ origin: "https://app.test" }));
  doubles.rpc.mockResolvedValue({ data: 5, error: null });
  doubles.encrypt.mockResolvedValue("encrypted-only");
});

describe.each([
  ["login empresarial", () => updateMetaNativeConfiguration(input)],
  ["segredo compartilhado", () => updateMetaApp({ app_secret: "secret-fixture-for-tests-only" })],
  ["verify token", () => rotacionarVerifyTokenDaMeta()],
] as const)("todos os writers: %s", (_name, write) => {
  it("recusa administrador de escopo restrito antes de ler ou cifrar credenciais", async () => {
    doubles.auth.mockResolvedValue({ user: { id: "actor" }, platformAdmin: { scope: "billing" } });
    expect(await write()).toEqual({ ok: false, error: "forbidden" });
    expect(doubles.rpc).not.toHaveBeenCalled();
    expect(doubles.encrypt).not.toHaveBeenCalled();
  });
  it("recusa suporte somente leitura", async () => {
    doubles.support.mockResolvedValue({ status: 403 });
    expect(await write()).toEqual({ ok: false, error: "support_read_only" });
    expect(doubles.encrypt).not.toHaveBeenCalled();
  });
  it("recusa desafio MFA pendente", async () => {
    doubles.mfa.mockResolvedValue(true);
    expect(await write()).toEqual({ ok: false, error: "mfa_required" });
    expect(doubles.encrypt).not.toHaveBeenCalled();
  });
  it("recusa escrita de outra origem", async () => {
    doubles.headers.mockResolvedValue(new Headers({ origin: "https://evil.test" }));
    expect(await write()).toEqual({ ok: false, error: "invalid_origin" });
    expect(doubles.encrypt).not.toHaveBeenCalled();
  });
});

describe("configuração administrativa do login Meta", () => {
  it("valida autorização antes de qualquer escrita", async () => {
    doubles.auth.mockRejectedValue(new Error("forbidden"));
    await expect(updateMetaNativeConfiguration(input)).rejects.toThrow("forbidden");
    expect(doubles.rpc).not.toHaveBeenCalled();
  });
  it("não admite administrador restrito", async () => {
    doubles.auth.mockResolvedValue({ user: { id: "actor" }, platformAdmin: { scope: "readonly" } });
    expect(await updateMetaNativeConfiguration(input)).toEqual({ ok: false, error: "forbidden" });
    expect(doubles.rpc).not.toHaveBeenCalled();
  });
  it("recusa acompanhamento somente leitura", async () => {
    doubles.support.mockResolvedValue({ status: 403 });
    expect(await updateMetaNativeConfiguration(input)).toMatchObject({ ok: false });
    expect(doubles.rpc).not.toHaveBeenCalled();
  });
  it("cobra desafio do fator já registrado mesmo com política opcional", async () => {
    doubles.mfa.mockResolvedValue(true);
    expect(await updateMetaNativeConfiguration(input)).toEqual({
      ok: false,
      error: "mfa_required",
    });
    expect(doubles.rpc).not.toHaveBeenCalled();
    expect(doubles.encrypt).not.toHaveBeenCalled();
  });
  it.each([null, "https://evil.test", "https://app.test/path"])(
    "recusa Origin %s",
    async (origin) => {
      doubles.headers.mockResolvedValue(new Headers(origin ? { origin } : {}));
      expect(await updateMetaNativeConfiguration(input)).toEqual({
        ok: false,
        error: "invalid_origin",
      });
      expect(doubles.rpc).not.toHaveBeenCalled();
    },
  );
  it("recusa fetch cross-site mesmo com Origin correto", async () => {
    doubles.headers.mockResolvedValue(
      new Headers({ origin: "https://app.test", "sec-fetch-site": "cross-site" }),
    );
    expect(await updateMetaNativeConfiguration(input)).toMatchObject({ ok: false });
    expect(doubles.rpc).not.toHaveBeenCalled();
  });
  it("CAS e segredo são passados de forma indivisível e cifrada", async () => {
    const secret = "secret-fixture-for-tests-only";
    expect(await updateMetaNativeConfiguration({ ...input, app_secret: secret })).toEqual({
      ok: true,
      revision: 5,
    });
    expect(doubles.rpc).toHaveBeenCalledWith(
      "fn_meta_app_configure",
      expect.objectContaining({ p_expected_revision: 4, p_app_secret_encrypted: "encrypted-only" }),
    );
    expect(JSON.stringify(doubles.audit.mock.calls)).not.toContain(secret);
    expect(doubles.invalidate).toHaveBeenCalledOnce();
  });
  it("sem segredo novo mantém o salvo pelo RPC", async () => {
    await updateMetaNativeConfiguration(input);
    expect(doubles.encrypt).not.toHaveBeenCalled();
    expect(doubles.rpc).toHaveBeenCalledWith(
      "fn_meta_app_configure",
      expect.objectContaining({ p_app_secret_encrypted: null }),
    );
  });
  it("cifra indisponível não permite persistir texto puro", async () => {
    doubles.encrypt.mockResolvedValue(null);
    expect(
      await updateMetaNativeConfiguration({
        ...input,
        app_secret: "secret-fixture-for-tests-only",
      }),
    ).toEqual({ ok: false, error: "encryption_unavailable" });
    expect(doubles.rpc).not.toHaveBeenCalled();
  });
  it("propaga conflito conhecido sem invalidar cache ou registrar sucesso", async () => {
    doubles.rpc.mockResolvedValue({
      data: null,
      error: { code: "PT409", message: "meta_app_config_changed" },
    });
    expect(await updateMetaNativeConfiguration(input)).toEqual({
      ok: false,
      error: "meta_app_config_changed",
    });
    expect(doubles.invalidate).not.toHaveBeenCalled();
    expect(doubles.audit).not.toHaveBeenCalled();
  });
  it("erro inesperado não vaza mensagem interna", async () => {
    doubles.rpc.mockResolvedValue({
      data: null,
      error: { code: "XX000", message: "sensitive internals" },
    });
    expect(await updateMetaNativeConfiguration(input)).toEqual({
      ok: false,
      error: "native_configuration_failed",
    });
  });
  it("recusa propriedade inesperada ou revisão inválida antes do banco", async () => {
    expect(await updateMetaNativeConfiguration({ ...input, expected_revision: -1 })).toMatchObject({
      ok: false,
    });
    expect(doubles.rpc).not.toHaveBeenCalled();
  });
});
