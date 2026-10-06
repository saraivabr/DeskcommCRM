import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { MetaIntegrationError } from "./types";

const MAX_BYTES = 16_384;

function invalid(status = 400): never {
  throw new MetaIntegrationError(
    "meta_callback_invalid",
    "Não foi possível validar a solicitação da Meta.",
    status,
  );
}

function decodeURLBase64(encoded: string): Buffer {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)) invalid();
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded.replace(/=+$/, "")) invalid();
  return decoded;
}

/** Only the app's signature supplies the identity; no cookies or tenant input. */
export function verifyMetaRemovalSignature(
  signedRequest: string,
  appSecret: string,
  now = Date.now(),
): { remoteActorId: string; issuedAt: string; signedRequestHash: string } {
  if (!appSecret || Buffer.byteLength(signedRequest, "utf8") > MAX_BYTES) invalid();
  const parts = signedRequest.split(".");
  const [signaturePart, payloadPart] = parts;
  if (parts.length !== 2 || signaturePart === undefined || payloadPart === undefined) invalid();
  const signature = decodeURLBase64(signaturePart);
  const expected = createHmac("sha256", appSecret).update(payloadPart).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) invalid(401);
  let value: unknown;
  try {
    value = JSON.parse(decodeURLBase64(payloadPart).toString("utf8"));
  } catch {
    invalid();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const payload = value as Record<string, unknown>;
  const issuedAt = payload.issued_at;
  const expires = payload.expires;
  if (
    typeof payload.algorithm !== "string" ||
    payload.algorithm.toUpperCase() !== "HMAC-SHA256" ||
    typeof payload.user_id !== "string" ||
    !/^\d{5,30}$/.test(payload.user_id) ||
    typeof issuedAt !== "number" ||
    !Number.isSafeInteger(issuedAt) ||
    issuedAt <= 0 ||
    issuedAt > Math.floor(now / 1000) + 300 ||
    (expires !== undefined &&
      (typeof expires !== "number" ||
        !Number.isSafeInteger(expires) ||
        expires < 0 ||
        (expires !== 0 && (expires < issuedAt || expires < Math.floor(now / 1000)))))
  )
    invalid();
  const timestamp = new Date(issuedAt * 1000);
  if (!Number.isFinite(timestamp.getTime())) invalid();
  return {
    remoteActorId: payload.user_id,
    issuedAt: timestamp.toISOString(),
    // Normalize harmless signature padding so the same proof has one receipt.
    signedRequestHash: createHash("sha256")
      .update(`${signature.toString("base64url")}.${payloadPart}`)
      .digest("hex"),
  };
}

/** Meta submits an application/x-www-form-urlencoded POST with signed_request. */
export async function readMetaRemovalSignedRequest(request: Request): Promise<string> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/x-www-form-urlencoded"
  )
    invalid(415);
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BYTES) invalid(413);
  const reader = request.body?.getReader();
  if (!reader) invalid();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_BYTES) {
        await reader.cancel();
        invalid(413);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const values = new URLSearchParams(Buffer.concat(chunks).toString("utf8")).getAll(
    "signed_request",
  );
  if (values.length !== 1 || !values[0]) invalid();
  return values[0];
}
