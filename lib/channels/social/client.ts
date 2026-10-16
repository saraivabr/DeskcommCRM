import { z } from "zod";
import { zernioBaseUrl } from "../zernio/credentials";
export class SocialError extends Error {
  constructor(
    message: string,
    public status = 502,
    public upstreamStatus?: number,
    public code = "social_unavailable",
  ) {
    super(message);
  }
}
/** Fixed provider origin. Credentials never follow a redirect to another host. */
export async function socialRequest(
  key: string,
  path: string,
  body?: unknown,
  options: { method?: "POST" | "PATCH"; requestId?: string } = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${zernioBaseUrl()}/v1/${path}`, {
      method: options.method ?? (body === undefined ? "GET" : "POST"),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(options.requestId
          ? { "x-request-id": options.requestId, "Idempotency-Key": options.requestId }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new SocialError("O provedor não respondeu. Tente novamente em instantes.", 503);
  }
  if (!response.ok) {
    if (response.status === 402)
      throw new SocialError(
        "A conexão social foi suspensa pelo provedor por cobrança. Peça a um administrador para conferir a conta do provedor.",
        402,
        402,
        "social_payment_required",
      );
    if (response.status === 401 || response.status === 403)
      throw new SocialError(
        "Acesso recusado pelo provedor. Confira a conexão e as permissões em Conexões.",
        422,
        response.status,
        "social_reauthorization_required",
      );
    throw new SocialError(
      response.status === 429
        ? "O provedor limitou as consultas. Aguarde um minuto antes de atualizar."
        : "O provedor está temporariamente indisponível. Tente novamente em instantes.",
      response.status === 429 ? 429 : 503,
      response.status,
      response.status === 429 ? "rate_limited" : "social_unavailable",
    );
  }
  try {
    return await response.json();
  } catch {
    throw new SocialError(
      "O provedor retornou uma resposta inválida. Tente novamente em instantes.",
      502,
      undefined,
      "social_invalid_response",
    );
  }
}
export function socialErrorDetails(error: unknown) {
  return error instanceof SocialError
    ? { code: error.code, message: error.message, status: error.status }
    : {
        code: "social_unavailable",
        message: "Não foi possível consultar a conexão social. Tente novamente.",
        status: 503,
      };
}
const accountSchema = z.object({
  _id: z.string(),
  platform: z.string(),
  username: z.string().nullish(),
  displayName: z.string().nullish(),
  profilePicture: z.string().nullish(),
  isActive: z.boolean(),
  profileId: z.union([z.string(), z.object({ _id: z.string(), name: z.string().optional() })]),
});
export type SocialAccount = z.infer<typeof accountSchema>;
export async function listSocialAccounts(key: string, profileId: string): Promise<SocialAccount[]> {
  const parsed = z
    .object({ accounts: z.array(accountSchema) })
    .safeParse(await socialRequest(key, `accounts?profileId=${encodeURIComponent(profileId)}`));
  if (!parsed.success) throw new SocialError("O provedor retornou uma lista de contas inválida.");
  return parsed.data.accounts.filter(
    (a) => (typeof a.profileId === "string" ? a.profileId : a.profileId._id) === profileId,
  );
}
