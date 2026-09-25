import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { WahaClient } from "./client";

describe("WAHA histórico antes do pareamento", () => {
  it("ativa o store NOWEB antes do start e pagina somente leitura", async () => {
    let created: Record<string, unknown> | null = null;
    const seen: string[] = [];
    const server = createServer(async (req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        created = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        res.writeHead(201).end("{}");
      } else if (req.url === "/api/sessions/s1") {
        res.end(JSON.stringify({ name: "s1", status: "STOPPED", engine: "NOWEB", config: (created as { config?: unknown } | null)?.config }));
      } else if (req.url?.includes("/chats/")) {
        res.end(JSON.stringify([{ id: "message-1", body: "Oi", timestamp: 1700000000, fromMe: false }]));
      } else {
        res.end(JSON.stringify([{ id: "5511999999999@c.us" }]));
      }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const client = new WahaClient(url, "test-key");
      await client.createSession("s1");
      expect((created as { config: { noweb: { store: unknown } } } | null)?.config.noweb.store)
        .toEqual({ enabled: true, fullSync: true });
      expect(await client.listHistoryChats("s1", 0, 1)).toEqual([{ id: "5511999999999@c.us" }]);
      expect(await client.listHistoryMessages("s1", "5511999999999@c.us", 0, 100))
        .toMatchObject([{ id: "message-1", body: "Oi" }]);
      expect(seen.filter((call) => call.startsWith("POST "))).toEqual(["POST /api/sessions"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
