import { describe, expect, it } from "vitest";
import { actionHash } from "@/lib/mcp/approvals";
describe("confirmation parameter binding", () => {
  it("binds tool, target, revision and operation identifier", () => {
    const args = { id: "page-a", expected_revision: 2, operation_id: "op-a" };
    const hash = actionHash("archive", args);
    expect(
      actionHash("archive", { operation_id: "op-a", expected_revision: 2, id: "page-a" }),
    ).toBe(hash);
    expect(actionHash("restore", args)).not.toBe(hash);
    expect(actionHash("archive", { ...args, id: "page-b" })).not.toBe(hash);
    expect(actionHash("archive", { ...args, expected_revision: 3 })).not.toBe(hash);
    expect(actionHash("archive", { ...args, operation_id: "op-b" })).not.toBe(hash);
  });
});
