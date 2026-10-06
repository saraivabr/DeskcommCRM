import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), connect: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ connect: mocks.connect }),
}));
import { queryMetaMedia, withMetaMediaLock } from "./media-lock";

const client = { query: mocks.query, release: mocks.release } as unknown as PoolClient;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.connect.mockResolvedValue(client);
  mocks.query.mockImplementation(async ({ text }: { text: string }) => ({
    rows: text.includes("current_setting")
      ? [{ timeout: "2min" }]
      : text.includes("pg_try_advisory")
        ? [{ locked: true }]
        : text.includes("pg_advisory_unlock")
          ? [{ unlocked: true }]
          : [],
  }));
});

describe("prepared-media session lock", () => {
  it("uses its checked-out session for work and restores the server timeout before reuse", async () => {
    expect(
      await withMetaMediaLock("CONNECTION", true, async (session) => {
        expect(session).toBe(client);
        expect(mocks.release).not.toHaveBeenCalled();
        await queryMetaMedia(session, "select publication", ["id"]);
        return 42;
      }),
    ).toBe(42);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.objectContaining({
        values: ["meta-privacy-connection:connection"],
        query_timeout: 5_000,
      }),
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "select set_config('statement_timeout','15s',false)",
        query_timeout: 15_000,
      }),
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "select publication",
        values: ["id"],
        query_timeout: 15_000,
      }),
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "select set_config('statement_timeout',$1,false)",
        values: ["2min"],
      }),
    );
    expect(mocks.release).toHaveBeenCalledWith(false);
  });
  it("destroys a session after failed I/O instead of returning outstanding work to the pool", async () => {
    await expect(
      withMetaMediaLock("connection", true, async () => {
        throw new Error("upload failed");
      }),
    ).rejects.toThrow("upload failed");
    expect(mocks.release).toHaveBeenCalledWith(true);
    expect(
      mocks.query.mock.calls.some(([query]) => query.text.includes("pg_advisory_unlock")),
    ).toBe(false);
  });
  it("never executes I/O if the cleaner has exclusive ownership", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ locked: false }] });
    const work = vi.fn();
    await expect(withMetaMediaLock("connection", true, work)).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith(false);
  });
  it("destroys a session when the acquisition response is uncertain", async () => {
    mocks.query.mockRejectedValueOnce(new Error("timeout"));
    await expect(withMetaMediaLock("connection", true, async () => 1)).rejects.toThrow();
    expect(mocks.release).toHaveBeenCalledWith(true);
  });
  it("destroys a session if restoring its timeout fails", async () => {
    const normal = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation((query) =>
      query.text.includes("statement_timeout',$1")
        ? Promise.reject(new Error("timeout"))
        : normal(query),
    );
    expect(await withMetaMediaLock("connection", false, async () => 2)).toBe(2);
    expect(mocks.release).toHaveBeenCalledWith(true);
  });
  it("destroys a session when its unlock cannot be confirmed", async () => {
    const normal = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation((query) =>
      query.text.includes("pg_advisory_unlock")
        ? Promise.resolve({ rows: [{ unlocked: false }] })
        : normal(query),
    );
    expect(await withMetaMediaLock("connection", false, async () => 2)).toBe(2);
    expect(mocks.release).toHaveBeenCalledWith(true);
  });
  it("blocks a duplicate with a canonical preparation key separate from the Storage trigger fence", async () => {
    const normal = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation((query) =>
      query.values?.[0] === "meta-media-preparation:org:pub"
        ? Promise.resolve({ rows: [{ locked: false }] })
        : normal(query),
    );
    const work = vi.fn();
    await expect(
      withMetaMediaLock("connection", true, work, {
        organizationId: "ORG",
        id: "PUB",
      }),
    ).rejects.toMatchObject({ code: "meta_preparation_busy" });
    expect(work).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith(true);
  });
});
