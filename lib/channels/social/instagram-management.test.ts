import { expect, it } from "vitest";
import { automationLogSchema } from "./instagram-management";

it("keeps failed executions whose public reply was never attempted", () => {
  const log = automationLogSchema.parse({
    id: "execution-1",
    status: "failed",
    commentText: "SEGURANÇA",
    commenterName: null,
    error: "Instagram rejected the private reply",
    commentReplyStatus: null,
    commentReplyError: null,
    createdAt: "2026-09-24T07:00:00Z",
  });
  expect(log.status).toBe("failed");
  expect(log.error).toBe("Instagram rejected the private reply");
  expect(log.commentReplyStatus).toBeNull();
});
