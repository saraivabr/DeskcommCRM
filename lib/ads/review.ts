import { createHash } from "node:crypto";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}
export function draftReviewHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function imageReviewHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
