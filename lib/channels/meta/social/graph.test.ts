import { describe, expect, it, vi } from "vitest";
import { MetaGraphClient } from "./graph";
import type { MetaPendingResult } from "./types";

const app = {
  appId: "123",
  configId: "321",
  revision: 1,
  appSecret: "app-secret",
  apiVersion: "v22.0",
  nativeEnabled: true,
  instagramEnabled: true,
  adsEnabled: true,
};
const token = (scopes: string[] = []): MetaPendingResult => ({
  remote_actor_id: "456",
  remote_actor_name: "Tester",
  access_token: "private-token",
  token_type: "USER",
  token_expires_at: null,
  data_access_expires_at: null,
  scopes,
  granular_scopes: [],
  assets: [],
});
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

describe("transporte Graph e validação da autorização", () => {
  it("não segue URLs nem redireciona e usa bearer, mantendo segredo fora da URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply({ id: "456" }));
    const graph = new MetaGraphClient(app, fetcher);
    await graph.request("me", "private-token", { query: { fields: "id" } });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(new URL(String(url)).origin).toBe("https://graph.facebook.com");
    expect(String(url)).not.toContain("private-token");
    expect(String(url)).not.toContain("app-secret");
    expect(options).toMatchObject({
      redirect: "error",
      cache: "no-store",
      headers: { authorization: "Bearer private-token" },
    });
    await expect(graph.request("https://evil.example", "private-token")).rejects.toMatchObject({
      code: "meta_graph_path_invalid",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("recusa token emitido para outro app antes de consultar me ou inventário", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        reply({ data: { app_id: "999", user_id: "456", is_valid: true, scopes: [] } }),
      );
    await expect(
      new MetaGraphClient(app, fetcher).inspectToken("private-token"),
    ).rejects.toMatchObject({ code: "meta_token_invalid" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("recusa sujeito diferente na revalidação mesmo com o app correto", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        reply({ data: { app_id: "123", user_id: "789", is_valid: true, scopes: [] } }),
      );
    await expect(
      new MetaGraphClient(app, fetcher).inspectToken("private-token", "456"),
    ).rejects.toMatchObject({ code: "meta_token_invalid" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("valida code e token longo e preserva expiração real, escopos e sujeito", async () => {
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reply({ access_token: "short-token" }))
      .mockResolvedValueOnce(
        reply({
          data: {
            app_id: "123",
            user_id: "456",
            is_valid: true,
            type: "USER",
            expires_at: expiry,
            scopes: [],
          },
        }),
      )
      .mockResolvedValueOnce(reply({ id: "456", name: "Tester" }))
      .mockResolvedValueOnce(reply({ access_token: "long-token" }))
      .mockResolvedValueOnce(
        reply({
          data: {
            app_id: "123",
            user_id: "456",
            is_valid: true,
            type: "USER",
            expires_at: expiry + 3600,
            scopes: [],
          },
        }),
      )
      .mockResolvedValueOnce(reply({ id: "456", name: "Tester" }));
    const result = await new MetaGraphClient(app, fetcher).exchangeCode(
      "private-code",
      "https://produto.example/api/v1/integrations/meta/callback",
    );
    expect(result).toMatchObject({
      access_token: "long-token",
      remote_actor_id: "456",
      assets: [],
      token_expires_at: new Date((expiry + 3600) * 1000).toISOString(),
    });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).not.toContain("private-code");
    expect(options?.method).toBe("POST");
    const body = new URLSearchParams(String(options?.body));
    expect(body.get("code")).toBe("private-code");
    expect(body.get("client_secret")).toBe("app-secret");
    expect(body.get("redirect_uri")).toBe(
      "https://produto.example/api/v1/integrations/meta/callback",
    );
  });

  it("descobre Page+IG vinculados e conta Ads sem inferir tarefas ausentes", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        reply({
          data: [
            {
              id: "11",
              name: "Página",
              tasks: ["CREATE_CONTENT"],
              access_token: "page-secret",
              instagram_business_account: { id: "22", username: "tester" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        reply({
          data: [
            {
              id: "act_33",
              account_id: "33",
              name: "Ads",
              currency: "BRL",
              timezone_name: "America/Sao_Paulo",
              account_status: 1,
            },
          ],
        }),
      );
    const result = await new MetaGraphClient(app, fetcher).discoverAssets(
      token(["pages_show_list", "instagram_basic", "ads_read"]),
    );
    expect(result).toHaveLength(3);
    expect(result[1]).toMatchObject({
      kind: "instagram",
      external_id: "22",
      parent_page_external_id: "11",
      tasks: ["CREATE_CONTENT"],
    });
    expect(result[2]).toMatchObject({
      kind: "ad_account",
      external_id: "33",
      currency: "BRL",
      tasks: [],
    });
  });

  it("consentimento parcial não consulta produto sem seu scope", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await new MetaGraphClient(app, fetcher).discoverAssets(token())).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("recusa paginação hostil antes de qualquer fetch para URL recebida", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        reply({
          data: [],
          paging: {
            next: "https://evil.example/steal?access_token=private-token",
            cursors: { after: "next" },
          },
        }),
      );
    await expect(
      new MetaGraphClient(app, fetcher).discoverAssets(token(["ads_read"])),
    ).rejects.toMatchObject({ code: "meta_pagination_invalid" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("erro remoto não ecoa tokens, code ou mensagem bruta", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        reply({ error: { code: 190, message: "private-token private-code app-secret" } }, 400),
      );
    let caught: unknown;
    try {
      await new MetaGraphClient(app, fetcher).request("me", "private-token");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "meta_token_invalid" });
    expect(String(caught)).not.toContain("private-token");
    expect(String(caught)).not.toContain("private-code");
    expect(String(caught)).not.toContain("app-secret");
  });
});
