import { beforeEach, expect, it, vi } from "vitest";
const { query, limit, audit, support } = vi.hoisted(() => ({
  query: vi.fn(),
  limit: vi.fn(),
  audit: vi.fn(),
  support: vi.fn(),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({ query }) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: limit }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: support }));
vi.mock("@/lib/audit", () => ({ audit }));
import { POST } from "@/app/api/v1/sales/waitlist/route";
const payload = {
  name: " Maria Silva ",
  email: " MARIA@example.com ",
  company: " Empresa ",
  website: "",
};
function request(body: unknown = payload, origin = "https://produto.example") {
  return new Request("https://produto.example/api/v1/sales/waitlist", {
    method: "POST",
    headers: { origin, "content-type": "application/json", "x-forwarded-for": "192.0.2.1" },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  support.mockResolvedValue(null);
  limit.mockResolvedValue({ allowed: true });
  query.mockResolvedValue({ rows: [{ id: "entry-1" }] });
  audit.mockResolvedValue(undefined);
});
it("normaliza email, grava com parâmetros e audita sem dados pessoais", async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { accepted: true } });
  expect(query).toHaveBeenCalledWith(expect.stringContaining("on conflict(email) do nothing"), [
    "Maria Silva",
    "maria@example.com",
    "Empresa",
  ]);
  expect(audit).toHaveBeenCalledWith(
    expect.objectContaining({
      resourceId: "entry-1",
      requestId: response.headers.get("x-request-id"),
    }),
  );
  expect(JSON.stringify(audit.mock.calls)).not.toContain("maria@example.com");
  expect(JSON.stringify(limit.mock.calls)).not.toContain("192.0.2.1");
});
it("duplicata recebe a mesma resposta sem criar conta ou reescrever contato", async () => {
  const first = await (await POST(request())).json();
  query.mockResolvedValue({ rows: [] });
  audit.mockClear();
  expect(await (await POST(request())).json()).toEqual(first);
  expect(audit).not.toHaveBeenCalled();
});
it("honeypot e quota de email respondem aceite sem persistir", async () => {
  expect((await POST(request({ ...payload, website: "spam" }))).status).toBe(200);
  expect(query).not.toHaveBeenCalled();
  limit.mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false });
  expect(await (await POST(request())).json()).toEqual({ data: { accepted: true } });
  expect(query).not.toHaveBeenCalled();
});
it("barra origem alheia, dados inválidos e corpo grande sem escrita", async () => {
  expect((await POST(request(payload, "https://outro.example"))).status).toBe(403);
  expect((await POST(request({ ...payload, email: "inválido" }))).status).toBe(400);
  expect((await POST(request({ ...payload, company: "x".repeat(5000) }))).status).toBe(413);
  expect(query).not.toHaveBeenCalled();
});
it("retorna 429 por IP e erro recuperável genérico quando persistência falha", async () => {
  limit.mockResolvedValueOnce({ allowed: false });
  expect((await POST(request())).status).toBe(429);
  expect(query).not.toHaveBeenCalled();
  query.mockRejectedValue(new Error("segredo do banco"));
  const response = await POST(request());
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("segredo do banco");
});
