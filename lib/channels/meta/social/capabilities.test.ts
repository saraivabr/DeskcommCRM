import { describe, expect, it } from "vitest";
import { assetCapabilities, tokenExpired } from "./capabilities";

const app = {
  appId: "1",
  configId: "2",
  revision: 1,
  appSecret: "secret",
  apiVersion: "v22.0",
  nativeEnabled: true,
  instagramEnabled: true,
  adsEnabled: true,
};
const scopes = [
  "ads_read",
  "ads_management",
  "instagram_basic",
  "instagram_content_publish",
  "pages_read_engagement",
];
describe("capacidade resulta de ativo, token, tarefas e instalação", () => {
  it("não autoriza gerir conta só por possuir ads_management", () => {
    const base = {
      app,
      kind: "ad_account" as const,
      externalId: "12",
      scopes,
      permissions: scopes,
      granularScopes: [],
      active: true,
      accountStatus: 1,
    };
    expect(assetCapabilities({ ...base, tasks: ["ANALYZE"] }).capabilities).toMatchObject({
      ads_read: true,
      ads_manage: false,
    });
    expect(assetCapabilities({ ...base, tasks: ["ADVERTISE"] }).capabilities.ads_manage).toBe(true);
    expect(
      assetCapabilities({ ...base, tasks: ["ADVERTISE"], accountStatus: 2 }).capabilities
        .ads_manage,
    ).toBe(false);
  });
  it("recusa scope destinado a outro ativo e autorização revogada", () => {
    const base = {
      app,
      kind: "ad_account" as const,
      externalId: "12",
      scopes,
      permissions: scopes,
      granularScopes: [
        { scope: "ads_management", target_ids: ["13"] },
        { scope: "ads_read", target_ids: ["13"] },
      ],
      tasks: ["MANAGE"],
      active: true,
      accountStatus: 1,
    };
    expect(assetCapabilities(base).capabilities.ads_manage).toBe(false);
    expect(assetCapabilities({ ...base, active: false }).capabilities.ads_read).toBe(false);
  });
  it("lista granular vazia não é wildcard; somente ausência de alvos é não granular", () => {
    const base = {
      app,
      kind: "ad_account" as const,
      externalId: "12",
      scopes: ["ads_management"],
      permissions: ["ads_management"],
      tasks: ["MANAGE"],
      active: true,
      accountStatus: 1,
    };
    expect(
      assetCapabilities({ ...base, granularScopes: [{ scope: "ads_management", target_ids: [] }] })
        .capabilities.ads_manage,
    ).toBe(false);
    expect(
      assetCapabilities({ ...base, granularScopes: [{ scope: "ads_management" }] }).capabilities
        .ads_manage,
    ).toBe(true);
    expect(assetCapabilities({ ...base, granularScopes: [] }).capabilities.ads_manage).toBe(true);
    expect(
      assetCapabilities({
        ...base,
        granularScopes: [{ scope: "ads_management", target_ids: ["12"] }],
      }).capabilities.ads_manage,
    ).toBe(true);
  });
  it("IG exige Página vinculada, tarefa, scope e flag", () => {
    const base = {
      app,
      kind: "instagram" as const,
      externalId: "33",
      parentPageExternalId: "44",
      scopes,
      permissions: scopes,
      granularScopes: [],
      tasks: ["CREATE_CONTENT"],
      active: true,
    };
    expect(assetCapabilities(base).capabilities.instagram_publish).toBe(true);
    expect(
      assetCapabilities({ ...base, parentPageExternalId: null }).capabilities.instagram_publish,
    ).toBe(false);
    expect(
      assetCapabilities({ ...base, app: { ...app, instagramEnabled: false } }).capabilities
        .instagram_publish,
    ).toBe(false);
    expect(
      assetCapabilities({ ...base, scopes: ["instagram_basic"] }).capabilities.instagram_publish,
    ).toBe(false);
  });
  it("validade nula não promete eternidade; datas vencidas/ilegíveis são recusadas", () => {
    expect(tokenExpired(null, null, 1000)).toBe(false);
    expect(tokenExpired("invalid", null, 1000)).toBe(true);
    expect(tokenExpired(null, "1970-01-01T00:00:01.000Z", 1000)).toBe(true);
  });
});
