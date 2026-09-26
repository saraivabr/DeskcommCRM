import { z } from "zod";
import { env } from "@/lib/env";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { hashSecret } from "./connections";

export const oauthOrigin = () => new URL(env.NEXT_PUBLIC_APP_URL).origin;
export const mcpResource = () => `${oauthOrigin()}/api/mcp`;
export const authorizeInput = z.object({
  response_type: z.literal("code"),
  client_id: z.string().uuid(),
  redirect_uri: z.string().url().max(2048),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal("S256"),
  scope: z.string().max(2048).default("knowledge:read"),
  state: z.string().min(1).max(2048),
  resource: z.string().url(),
});
export function validRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    return (
      !u.hash &&
      !u.username &&
      !u.password &&
      (u.protocol === "https:" ||
        (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)))
    );
  } catch {
    return false;
  }
}
export function oauthJson(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
  });
}
export async function oauthRateLimit(req: Request) {
  const ip =
    req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0] ?? "unknown";
  return (await checkRateLimit(`mcp:oauth:${hashSecret(ip)}`, 30, 60)).allowed;
}
