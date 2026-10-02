// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
const platform = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/runtime/agent", () => ({ chaveDePlataforma: platform }));
import { publishAgentVersionWithClient } from "@/lib/ai/agents/publish";
const params = { orgId: "org", agentId: "agent", versionId: "version" };
const published = {
  agent_id: "agent",
  version_id: "version",
  previous_version_id: null,
  published_at: "2026-10-01T00:00:00Z",
};
function database(credential: string | null = null) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [{ provider: "openai", credential_id: credential }] })
    .mockResolvedValueOnce({ rows: [published] });
  return { db: { query } as unknown as pg.PoolClient, query };
}
beforeEach(() => {
  vi.clearAllMocks();
  platform.mockReturnValue("configured-key");
});
describe("canonical publication on an existing transaction", () => {
  it("executes the canonical function on that client with a verified platform key", async () => {
    const { db, query } = database();
    expect(await publishAgentVersionWithClient(db, params)).toEqual({ ok: true, ...published });
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("for update"), [
      "org",
      "agent",
      "version",
    ]);
    expect(query).toHaveBeenNthCalledWith(
      2,
      "select * from public.fn_publish_ai_agent_version($1::uuid,$2::uuid,$3::uuid,$4::boolean,$5::text)",
      ["org", "agent", "version", true, null],
    );
    expect(platform).toHaveBeenCalledWith("openai");
  });
  it("never treats an organization credential as a verified platform key and forwards provenance", async () => {
    const { db, query } = database("organization-credential");
    await publishAgentVersionWithClient(db, { ...params, expectedProvenance: "onboarding" });
    expect(platform).not.toHaveBeenCalled();
    expect(query.mock.calls[1]![1]).toEqual(["org", "agent", "version", false, "onboarding"]);
  });
  it("refuses a missing platform key before executing publication", async () => {
    const { db, query } = database();
    platform.mockReturnValue(null);
    expect(await publishAgentVersionWithClient(db, params)).toMatchObject({
      ok: false,
      code: "credential_missing",
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("refuses an absent version scoped to the organization", async () => {
    const { db, query } = database();
    query.mockReset().mockResolvedValue({ rows: [] });
    expect(await publishAgentVersionWithClient(db, params)).toMatchObject({
      ok: false,
      code: "version_not_found",
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("returns the same canonical validation reason so the caller can roll back", async () => {
    const { db, query } = database();
    query
      .mockReset()
      .mockResolvedValueOnce({ rows: [{ provider: "openai", credential_id: "org-key" }] })
      .mockRejectedValueOnce(new Error("credential_not_validated"));
    expect(await publishAgentVersionWithClient(db, params)).toEqual({
      ok: false,
      code: "credential_not_validated",
      message: "credential_not_validated",
    });
  });
});
