import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fail } from "@/lib/api/wrappers";
import { POST as start } from "./start/route";
import { POST as finalize } from "./finalize/route";
import { POST as selectAssets } from "./assets/route";
import { POST as disconnect } from "./disconnect/route";
import { GET as callback } from "./callback/route";

const m = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  session: vi.fn(),
  rate: vi.fn(),
  start: vi.fn(),
  finalize: vi.fn(),
  callback: vi.fn(),
  selectAssets: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://produto.example" } }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: m.role }));
vi.mock("@/lib/auth/rate-limit", () => ({ authRateLimited: m.rate }));
vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: m.support,
  authenticatedSessionId: m.session,
}));
vi.mock("@/lib/supabase/cookie-secure", () => ({ cookieSecure: () => true }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("@/lib/channels/meta/social/service", () => ({
  MetaNativeService: class {
    start = m.start;
    finalize = m.finalize;
    callback = m.callback;
    selectAssets = m.selectAssets;
    disconnect = m.disconnect;
  },
}));

const ORG = "10000000-0000-4000-8000-000000000001";
const ACTOR = "10000000-0000-4000-8000-000000000002";
const SESSION = "10000000-0000-4000-8000-000000000003";
const CONNECTION = "10000000-0000-4000-8000-000000000004";
const request = (path: string, body: unknown, origin = "https://produto.example") =>
  new Request(`https://produto.example/api/v1/integrations/meta/${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", "x-request-id": "request-id" },
    body: JSON.stringify(body),
  });

describe("API Meta nativa usa sessão atual e retorna somente contrato seguro", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.role.mockResolvedValue({ ok: true, user: { id: ACTOR }, org: { orgId: ORG } });
    m.support.mockResolvedValue(null);
    m.session.mockResolvedValue(SESSION);
    m.rate.mockResolvedValue(false);
    m.start.mockResolvedValue({
      authorization_url: "https://www.facebook.com/dialog/oauth?state=opaque",
      cookie: "c".repeat(43),
    });
    m.finalize.mockResolvedValue({
      connection_id: CONNECTION,
      version: 1,
      status: "selection_pending",
    });
  });
  it("start usa admin/MFA canônico e mantém cookie Lax separado da sessão", async () => {
    const response = await start(request("start", {}));
    expect(response.status).toBe(200);
    expect(m.role).toHaveBeenCalledWith(
      "admin",
      expect.objectContaining({ resource: "meta_connections" }),
    );
    expect(m.start).toHaveBeenCalledWith(
      { organizationId: ORG, actorId: ACTOR, sessionId: SESSION },
      "https://produto.example",
      "request-id",
    );
    expect(response.headers.get("set-cookie")).toContain("SameSite=lax");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Path=/api/v1/integrations/meta/callback");
    expect(await response.json()).toEqual({
      data: { authorization_url: "https://www.facebook.com/dialog/oauth?state=opaque" },
    });
  });
  it.each(["https://evil.example", "null"])(
    "Origin %s não cria tentativa nem ativa retorno",
    async (origin) => {
      expect((await start(request("start", {}, origin))).status).toBe(403);
      expect((await finalize(request("finalize", { ticket: "t".repeat(43) }, origin))).status).toBe(
        403,
      );
      expect(m.start).not.toHaveBeenCalled();
      expect(m.finalize).not.toHaveBeenCalled();
    },
  );
  it("Origin ausente recusa cookie-auth, inclusive finalize", async () => {
    const req = request("finalize", { ticket: "t".repeat(43) });
    req.headers.delete("origin");
    expect((await finalize(req)).status).toBe(403);
    expect(m.finalize).not.toHaveBeenCalled();
  });
  it("suporte somente leitura barra todas as mutações antes de clientes privileged", async () => {
    m.support.mockResolvedValue(fail("forbidden", "Somente leitura", 403));
    expect((await start(request("start", {}))).status).toBe(403);
    expect((await finalize(request("finalize", { ticket: "t".repeat(43) }))).status).toBe(403);
    expect(
      (await selectAssets(request("assets", { connection_id: CONNECTION, asset_ids: [] }))).status,
    ).toBe(403);
    expect((await disconnect(request("disconnect", { connection_id: CONNECTION }))).status).toBe(
      403,
    );
    expect(m.start).not.toHaveBeenCalled();
    expect(m.finalize).not.toHaveBeenCalled();
    expect(m.selectAssets).not.toHaveBeenCalled();
    expect(m.disconnect).not.toHaveBeenCalled();
  });
  it("finalize passa org/ator/session_id da autenticação nova e nunca do corpo", async () => {
    const response = await finalize(request("finalize", { ticket: "t".repeat(43) }));
    expect(response.status).toBe(200);
    expect(m.finalize).toHaveBeenCalledWith(
      { organizationId: ORG, actorId: ACTOR, sessionId: SESSION },
      "t".repeat(43),
      "request-id",
    );
    expect(
      (await finalize(request("finalize", { ticket: "t".repeat(43), organization_id: "other" })))
        .status,
    ).toBe(400);
  });
  it("retirada de papel/MFA/logout nega a ativação, sem reutilizar estado antigo", async () => {
    m.role.mockResolvedValue({
      ok: false,
      response: fail("mfa_required", "Verifique a sessão", 403),
    });
    expect((await finalize(request("finalize", { ticket: "t".repeat(43) }))).status).toBe(403);
    expect(m.finalize).not.toHaveBeenCalled();
  });
  it("callback só devolve ticket opaco via bridge; code/state não voltam para a UI", async () => {
    m.callback.mockResolvedValue({ ticket: "t".repeat(43) });
    const response = await callback(
      new NextRequest(
        `https://produto.example/api/v1/integrations/meta/callback?state=${"s".repeat(43)}&code=private-code`,
        { headers: { cookie: `meta_native_oauth=${"c".repeat(43)}` } },
      ),
    );
    const html = await response.text();
    expect(m.callback).toHaveBeenCalledWith(
      { state: "s".repeat(43), code: "private-code" },
      "c".repeat(43),
      "https://produto.example",
      expect.any(String),
    );
    expect(html).toContain("meta_ticket=");
    expect(html).not.toContain("private-code");
    expect(html).not.toContain("s".repeat(43));
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
  it("callback sem cookie de vínculo ou nonce malformado não troca code", async () => {
    const response = await callback(
      new NextRequest(
        `https://produto.example/api/v1/integrations/meta/callback?state=${"s".repeat(43)}&code=private-code`,
      ),
    );
    expect(m.callback).not.toHaveBeenCalled();
    expect(await response.text()).toContain("meta_error=invalid_state");
  });
});
