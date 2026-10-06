import { createHmac } from "node:crypto";
import { z } from "zod";
import {
  MetaIntegrationError,
  metaGranularScopeSchema,
  metaPendingResultSchema,
  type MetaDiscoveredAsset,
  type MetaNativeApp,
  type MetaPendingResult,
} from "./types";
import { tokenExpired } from "./capabilities";

const id = z.string().regex(/^\d+$/).max(100);
const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(10000),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
});
const debugSchema = z.object({
  data: z.object({
    app_id: id,
    user_id: id,
    is_valid: z.boolean(),
    type: z.string().optional(),
    expires_at: z.number().int().nonnegative().optional(),
    data_access_expires_at: z.number().int().nonnegative().optional(),
    scopes: z.array(z.string()).max(100).default([]),
    granular_scopes: z.array(metaGranularScopeSchema).max(100).default([]),
  }),
});
const pageSchema = z.object({
  id,
  name: z.string().max(500),
  tasks: z.array(z.string()).default([]),
  access_token: z.string().max(10000).optional(),
  instagram_business_account: z
    .object({ id, username: z.string().optional(), name: z.string().optional() })
    .optional(),
});
const adAccountSchema = z.object({
  id: z.string().regex(/^act_\d+$/),
  account_id: id,
  name: z.string().max(500),
  currency: z.string().optional(),
  timezone_name: z.string().optional(),
  account_status: z.number().int(),
  user_tasks: z.array(z.string()).default([]),
});
const paginationSchema = z.object({
  paging: z
    .object({
      next: z.string().optional(),
      cursors: z.object({ after: z.string().max(4000).optional() }).optional(),
    })
    .optional(),
});

/** Transporte restrito a Graph/version/paging conhecidos; sem redirects ou URLs recebidas do cliente. */
export class MetaGraphClient {
  constructor(
    private readonly app: MetaNativeApp,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!app.appId || !app.appSecret || !/^v\d+\.\d+$/.test(app.apiVersion)) {
      throw new MetaIntegrationError(
        "meta_not_configured",
        "A credencial do app Meta não está disponível.",
      );
    }
  }

  private url(path: string, query: Record<string, string>): URL {
    if (!/^[A-Za-z0-9_/-]+$/.test(path) || path.includes("..") || path.startsWith("/")) {
      throw new MetaIntegrationError(
        "meta_graph_path_invalid",
        "Caminho de integração inválido.",
        500,
      );
    }
    const url = new URL(`https://graph.facebook.com/${this.app.apiVersion}/${path}`);
    url.search = new URLSearchParams(query).toString();
    return url;
  }

  async request(
    path: string,
    token: string,
    options: {
      query?: Record<string, string>;
      body?: Record<string, string>;
      method?: "GET" | "POST" | "DELETE";
      appToken?: boolean;
    } = {},
  ): Promise<unknown> {
    const method = options.method ?? "GET";
    const query = { ...options.query };
    if (!options.appToken)
      query.appsecret_proof = createHmac("sha256", this.app.appSecret!).update(token).digest("hex");
    const url = this.url(path, query);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(options.body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(options.body ? { body: new URLSearchParams(options.body) } : {}),
      });
    } catch {
      throw new MetaIntegrationError(
        "meta_provider_unavailable",
        "A Meta não respondeu. Tente verificar ou reconectar novamente.",
        502,
      );
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new MetaIntegrationError(
        "meta_provider_response_invalid",
        "A Meta devolveu uma resposta ilegível.",
        502,
      );
    }
    const error = z.object({ error: z.object({ code: z.number().optional() }) }).safeParse(data);
    if (!response.ok || error.success) {
      const code = error.success ? error.data.error.code : undefined;
      if (code === 190)
        throw new MetaIntegrationError(
          "meta_token_invalid",
          "A autorização Meta expirou ou foi revogada. Reconecte a conta.",
          409,
        );
      if (code === 10 || code === 200)
        throw new MetaIntegrationError(
          "meta_permission_missing",
          "A Meta recusou a permissão necessária. Reautorize o acesso.",
          422,
        );
      // A mensagem bruta do provedor pode conter code/token/request: não cruza a fronteira.
      throw new MetaIntegrationError(
        "meta_provider_error",
        "A Meta recusou a solicitação. Verifique o acesso do app e reconecte.",
        502,
      );
    }
    return data;
  }

  async inspectToken(token: string, expectedActorId?: string): Promise<MetaPendingResult> {
    const parsed = debugSchema.safeParse(
      await this.request("debug_token", `${this.app.appId}|${this.app.appSecret}`, {
        appToken: true,
        query: { input_token: token },
      }),
    );
    if (!parsed.success)
      throw new MetaIntegrationError(
        "meta_token_invalid",
        "Não foi possível confirmar a origem da autorização Meta.",
        409,
      );
    const debug = parsed.data.data;
    if (
      !debug.is_valid ||
      debug.app_id !== this.app.appId ||
      (expectedActorId && debug.user_id !== expectedActorId)
    ) {
      throw new MetaIntegrationError(
        "meta_token_invalid",
        "A autorização não corresponde ao app e à conta esperados. Reconecte.",
        409,
      );
    }
    const expiration = (v?: number) => (v ? new Date(v * 1000).toISOString() : null);
    const tokenExpiresAt = expiration(debug.expires_at);
    const dataExpiresAt = expiration(debug.data_access_expires_at);
    if (tokenExpired(tokenExpiresAt, dataExpiresAt))
      throw new MetaIntegrationError(
        "meta_token_invalid",
        "A autorização Meta venceu. Reconecte.",
        409,
      );
    const actor = z
      .object({ id, name: z.string().max(500).optional() })
      .safeParse(await this.request("me", token, { query: { fields: "id,name" } }));
    if (!actor.success || actor.data.id !== debug.user_id)
      throw new MetaIntegrationError(
        "meta_token_invalid",
        "A conta Meta não corresponde à autorização recebida.",
        409,
      );
    return {
      remote_actor_id: debug.user_id,
      remote_actor_name: actor.data.name ?? "Conta Meta",
      access_token: token,
      token_type: debug.type ?? "USER",
      token_expires_at: tokenExpiresAt,
      data_access_expires_at: dataExpiresAt,
      scopes: debug.scopes,
      granular_scopes: debug.granular_scopes,
      assets: [],
    };
  }

  async exchangeCode(code: string, redirectUri: string): Promise<MetaPendingResult> {
    const first = tokenResponseSchema.safeParse(
      await this.request("oauth/access_token", `${this.app.appId}|${this.app.appSecret}`, {
        method: "POST",
        appToken: true,
        body: {
          client_id: this.app.appId!,
          client_secret: this.app.appSecret!,
          redirect_uri: redirectUri,
          code,
        },
      }),
    );
    if (!first.success)
      throw new MetaIntegrationError(
        "meta_token_invalid",
        "A Meta não devolveu uma autorização utilizável.",
        502,
      );
    let validated = await this.inspectToken(first.data.access_token);
    if (validated.token_type === "USER") {
      const long = tokenResponseSchema.safeParse(
        await this.request("oauth/access_token", `${this.app.appId}|${this.app.appSecret}`, {
          method: "POST",
          appToken: true,
          body: {
            grant_type: "fb_exchange_token",
            client_id: this.app.appId!,
            client_secret: this.app.appSecret!,
            fb_exchange_token: first.data.access_token,
          },
        }),
      );
      if (!long.success)
        throw new MetaIntegrationError(
          "meta_token_invalid",
          "Não foi possível obter a autorização durável. Reconecte.",
          502,
        );
      validated = await this.inspectToken(long.data.access_token, validated.remote_actor_id);
    }
    validated.assets = await this.discoverAssets(validated);
    return metaPendingResultSchema.parse(validated);
  }

  private async collection<T>(
    path: string,
    token: string,
    fields: string,
    schema: z.ZodType<T>,
  ): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const raw = await this.request(path, token, {
        query: { fields, limit: "100", ...(after ? { after } : {}) },
      });
      const result = z
        .object({ data: z.array(schema).max(1000) })
        .and(paginationSchema)
        .safeParse(raw);
      if (!result.success)
        throw new MetaIntegrationError(
          "meta_assets_invalid",
          "A lista de ativos da Meta não pôde ser confirmada.",
          502,
        );
      out.push(...result.data.data);
      if (out.length > 1000)
        throw new MetaIntegrationError(
          "meta_inventory_limit",
          "Esta conta excede o limite de ativos desta conexão.",
          422,
        );
      if (!result.data.paging?.next) return out;
      const next = new URL(result.data.paging.next);
      if (
        next.origin !== "https://graph.facebook.com" ||
        next.pathname !== `/${this.app.apiVersion}/${path}`
      ) {
        throw new MetaIntegrationError(
          "meta_pagination_invalid",
          "A paginação dos ativos foi recusada.",
          502,
        );
      }
      after = result.data.paging.cursors?.after;
      if (!after || seen.has(after))
        throw new MetaIntegrationError(
          "meta_pagination_invalid",
          "A paginação dos ativos não avançou.",
          502,
        );
      seen.add(after);
    }
    throw new MetaIntegrationError(
      "meta_inventory_limit",
      "Esta conta excede o limite de páginas desta conexão.",
      422,
    );
  }

  async discoverAssets(token: MetaPendingResult): Promise<MetaDiscoveredAsset[]> {
    const observedAt = new Date().toISOString();
    const assets: MetaDiscoveredAsset[] = [];
    if (token.scopes.includes("pages_show_list")) {
      const fields =
        "id,name,tasks,access_token" +
        (token.scopes.includes("instagram_basic")
          ? ",instagram_business_account{id,username,name}"
          : "");
      const pages = await this.collection("me/accounts", token.access_token, fields, pageSchema);
      for (const page of pages) {
        assets.push({
          kind: "page",
          external_id: page.id,
          name: page.name,
          metadata: { observed_at: observedAt },
          tasks: page.tasks,
          permissions: token.scopes,
          ...(page.access_token ? { page_access_token: page.access_token } : {}),
        });
        const instagram = page.instagram_business_account;
        if (instagram)
          assets.push({
            kind: "instagram",
            external_id: instagram.id,
            name: instagram.name ?? instagram.username ?? page.name,
            parent_page_external_id: page.id,
            metadata: {
              observed_at: observedAt,
              ...(instagram.username ? { username: instagram.username } : {}),
            },
            tasks: page.tasks,
            permissions: token.scopes,
          });
      }
    }
    if (token.scopes.includes("ads_read") || token.scopes.includes("ads_management")) {
      const accounts = await this.collection(
        "me/adaccounts",
        token.access_token,
        "id,account_id,name,currency,timezone_name,account_status,user_tasks",
        adAccountSchema,
      );
      for (const account of accounts)
        assets.push({
          kind: "ad_account",
          external_id: account.account_id,
          name: account.name,
          ...(account.currency ? { currency: account.currency } : {}),
          ...(account.timezone_name ? { timezone: account.timezone_name } : {}),
          metadata: { observed_at: observedAt, account_status: account.account_status },
          tasks: account.user_tasks,
          permissions: token.scopes,
        });
    }
    return assets;
  }
}
