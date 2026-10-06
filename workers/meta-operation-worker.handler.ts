import type { EventHandler } from "@/lib/event-log/dispatcher";
import { handleMetaOperation, META_OPERATION_CONSUMER } from "./meta-operation-worker";
export const metaOperationHandler: EventHandler = {
  key: META_OPERATION_CONSUMER,
  events: ["meta.operation_requested"],
  handle: handleMetaOperation,
};
