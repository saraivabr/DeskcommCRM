import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MetaConnectionStore } from "./store";
import { hashOpaque } from "./oauth";

const secrets = vi.hoisted(() => ({ encrypt: vi.fn(), decrypt: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: secrets.encrypt,
  decryptWebhookSecret: secrets.decrypt,
}));
const ORG = "10000000-0000-4000-8000-000000000001";
const ACTOR = "10000000-0000-4000-8000-000000000002";
const CONNECTION = "10000000-0000-4000-8000-000000000003";
const SESSION = "10000000-0000-4000-8000-000000000004";
const app = {
  appId: "123",
  configId: "321",
  revision: 4,
  appSecret: "app-secret",
  apiVersion: "v22.0",
  nativeEnabled: true,
  instagramEnabled: true,
  adsEnabled: true,
};
const attempt = {
  id: CONNECTION,
  organization_id: ORG,
  actor_id: ACTOR,
  auth_session_id: SESSION,
  app_id: "123",
  config_id: "321",
  config_revision: 4,
  callback_claim_id: SESSION,
};
const pending = {
  remote_actor_id: "456",
  remote_actor_name: "Tester",
  access_token: "private-token",
  token_type: "USER",
  token_expires_at: null,
  data_access_expires_at: null,
  scopes: [],
  granular_scopes: [],
  assets: [],
};

describe("persistência OAuth guarda provas hash/cifra e só devolve projeção permitida", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("criação nunca persiste state/cookie ou segredo do app em plaintext", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const db = { from: vi.fn(() => ({ insert })) } as unknown as SupabaseClient;
    await new MetaConnectionStore(db).createAttempt(
      { organizationId: ORG, actorId: ACTOR, sessionId: SESSION },
      app,
      "s".repeat(43),
      "c".repeat(43),
      "2026-10-05T18:00:00.000Z",
    );
    const row = insert.mock.calls[0]![0];
    expect(row).toMatchObject({
      organization_id: ORG,
      actor_id: ACTOR,
      auth_session_id: SESSION,
      app_id: "123",
      config_revision: 4,
      state_hash: hashOpaque("s".repeat(43)),
      cookie_hash: hashOpaque("c".repeat(43)),
    });
    expect(JSON.stringify(row)).not.toContain("app-secret");
    expect(JSON.stringify(row)).not.toContain("s".repeat(43));
    expect(JSON.stringify(row)).not.toContain("c".repeat(43));
  });
  it("cipher indisponível impede guardar resultado pronto, sem fallback plaintext", async () => {
    secrets.encrypt.mockResolvedValue(null);
    const rpc = vi.fn();
    await expect(
      new MetaConnectionStore({ rpc } as unknown as SupabaseClient).storeResult(
        attempt,
        "ticket",
        pending,
      ),
    ).rejects.toMatchObject({ code: "meta_encryption_unavailable" });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("resultado pronto consome claim e persiste ticket hasheado+cipher", async () => {
    secrets.encrypt.mockResolvedValue("\\x0123");
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const db = { rpc } as unknown as SupabaseClient;
    await new MetaConnectionStore(db).storeResult(attempt, "ticket", pending);
    expect(rpc).toHaveBeenCalledWith("fn_meta_oauth_store_result", {
      p_attempt_id: CONNECTION,
      p_callback_claim_id: SESSION,
      p_ticket_hash: hashOpaque("ticket"),
      p_result_encrypted: "\\x0123",
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("private-token");
  });
  it("status descarta qualquer campo privado retornado pelo banco e filtra cada query pela org", async () => {
    const eqs: Array<[string, unknown]> = [];
    const connectionRows = [
      {
        id: CONNECTION,
        actor_name: "Tester",
        status: "healthy",
        token_expires_at: null,
        data_access_expires_at: null,
        scopes: ["ads_read"],
        last_validated_at: "2026-10-05T18:00:00.000Z",
        app_id: "123",
        oauth_access_token_encrypted: "\\xsecret",
        access_token: "private-token",
      },
    ];
    const chain = (data: unknown) => {
      const query = {
        select: vi.fn(),
        eq: vi.fn(),
        order: vi.fn(),
        limit: vi.fn(),
        then: (resolve: (v: unknown) => void) => resolve({ data, error: null }),
      };
      query.select.mockReturnValue(query);
      query.order.mockReturnValue(query);
      query.limit.mockReturnValue(query);
      query.eq.mockImplementation((key: string, value: unknown) => {
        eqs.push([key, value]);
        return query;
      });
      return query;
    };
    const db = {
      from: vi.fn((table: string) =>
        chain(
          table === "meta_connections"
            ? connectionRows
            : [
                {
                  connection_id: CONNECTION,
                  selected: true,
                  status: "healthy",
                  page_access_token_encrypted: "\\xpage-secret",
                },
              ],
        ),
      ),
    } as unknown as SupabaseClient;
    const response = await new MetaConnectionStore(db).status(ORG, app, true);
    expect(response.connections[0]).toMatchObject({
      id: CONNECTION,
      selected_asset_count: 1,
      reconnect_required: false,
    });
    expect(eqs.filter(([key]) => key === "organization_id")).toEqual([
      ["organization_id", ORG],
      ["organization_id", ORG],
    ]);
    expect(JSON.stringify(response)).not.toContain("private-token");
    expect(JSON.stringify(response)).not.toContain("secret");
  });
  it("finalize não resolve tenant pelo ticket: envia ator/org/sessão junto na única RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { connection_id: CONNECTION, version: 2, status: "selection_pending" },
      error: null,
    });
    await new MetaConnectionStore({ rpc } as unknown as SupabaseClient).finalize(
      { organizationId: ORG, actorId: ACTOR, sessionId: SESSION },
      "ticket",
    );
    expect(rpc).toHaveBeenCalledExactlyOnceWith("fn_meta_oauth_finalize", {
      p_organization_id: ORG,
      p_actor_id: ACTOR,
      p_auth_session_id: SESSION,
      p_ticket_hash: hashOpaque("ticket"),
    });
  });

  it("permissão negada não reapresenta capacidades antigas do inventário", async () => {
    const assetId = "10000000-0000-4000-8000-000000000005";
    const fixtures: Record<string, unknown> = {
      meta_connections: {
        id: CONNECTION,
        organization_id: ORG,
        app_id: "123",
        local_actor_id: ACTOR,
        remote_actor_id: "456",
        actor_name: "Tester",
        status: "scope_missing",
        oauth_access_token_encrypted: "\\xsecret",
        token_type: "USER",
        token_expires_at: null,
        data_access_expires_at: null,
        scopes: ["ads_management"],
        granular_scopes: [],
        version: 1,
        last_validated_at: "2026-10-05T18:00:00.000Z",
      },
      meta_asset_grants: [
        {
          asset_id: assetId,
          tasks: ["MANAGE"],
          permissions: ["ads_management"],
          status: "healthy",
          selected: true,
        },
      ],
      meta_assets: [
        {
          id: assetId,
          kind: "ad_account",
          external_id: "789",
          name: "Ads",
          parent_page_id: null,
          currency: "BRL",
          timezone: "America/Sao_Paulo",
          metadata: { account_status: 1 },
        },
      ],
    };
    const chain = (data: unknown) => {
      const query = {
        select: vi.fn(),
        eq: vi.fn(),
        in: vi.fn(),
        maybeSingle: vi.fn(),
        then: (resolve: (v: unknown) => void) => resolve({ data, error: null }),
      };
      query.select.mockReturnValue(query);
      query.eq.mockReturnValue(query);
      query.in.mockReturnValue(query);
      query.maybeSingle.mockResolvedValue({ data, error: null });
      return query;
    };
    const db = {
      from: vi.fn((table: string) => chain(fixtures[table])),
    } as unknown as SupabaseClient;
    const assets = await new MetaConnectionStore(db).assets(ORG, CONNECTION, app);
    expect(assets[0]?.capabilities).toEqual({
      ads_read: false,
      ads_manage: false,
      instagram_publish: false,
    });
    expect(assets[0]?.unavailable_reason).toContain("Reconecte");
  });
});
