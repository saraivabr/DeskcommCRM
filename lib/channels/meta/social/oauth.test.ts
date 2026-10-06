import { describe, expect, it } from "vitest";
import {
  hashOpaque,
  montarMetaAuthorizationUrl,
  sameOriginMutation,
  metaCallbackDestination,
} from "./oauth";

describe("vínculo e retorno do login empresarial", () => {
  it("pede code com config_id, state e redirect URI, sem scope/segredo", () => {
    const url = new URL(
      montarMetaAuthorizationUrl(
        {
          appId: "123456",
          configId: "654321",
          revision: 1,
          appSecret: "secret",
          apiVersion: "v22.0",
          nativeEnabled: true,
          instagramEnabled: true,
          adsEnabled: true,
        },
        "https://produto.example",
        "state",
      ),
    );
    expect(url.hostname).toBe("www.facebook.com");
    expect(url.searchParams.get("config_id")).toBe("654321");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("override_default_response_type")).toBe("true");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://produto.example/api/v1/integrations/meta/callback",
    );
    expect(url.searchParams.get("state")).toBe("state");
    expect(url.searchParams.has("scope")).toBe(false);
    expect(url.toString()).not.toContain("secret");
  });
  it("falha fechada sem config ou recurso habilitado", () => {
    expect(() =>
      montarMetaAuthorizationUrl(
        {
          appId: "123",
          configId: null,
          revision: 1,
          appSecret: "secret",
          apiVersion: "v22.0",
          nativeEnabled: true,
          instagramEnabled: false,
          adsEnabled: false,
        },
        "https://produto.example",
        "state",
      ),
    ).toThrow();
  });
  it("recusa Origin ausente/divergente, mesmo com host interno igual request", () => {
    const publicOrigin = "https://produto.example";
    expect(
      sameOriginMutation(
        new Request("http://app:3000", { headers: { origin: publicOrigin } }),
        publicOrigin,
      ),
    ).toBe(true);
    expect(sameOriginMutation(new Request(publicOrigin), publicOrigin)).toBe(false);
    expect(
      sameOriginMutation(
        new Request(publicOrigin, { headers: { origin: "https://evil.example" } }),
        publicOrigin,
      ),
    ).toBe(false);
    expect(
      sameOriginMutation(
        new Request(publicOrigin, {
          headers: { origin: publicOrigin, "sec-fetch-site": "cross-site" },
        }),
        publicOrigin,
      ),
    ).toBe(false);
  });
  it("põe só ticket opaco no retorno e mantém destino fixo", () => {
    expect(metaCallbackDestination({ ticket: "a".repeat(43) })).toBe(
      "/app/connections?aba=sociais&meta_ticket=" + "a".repeat(43),
    );
    expect(metaCallbackDestination({ error: "cancelled" })).toBe(
      "/app/connections?aba=sociais&meta_error=cancelled",
    );
    expect(hashOpaque("token")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashOpaque("token")).not.toBe(hashOpaque("Token"));
  });
});
