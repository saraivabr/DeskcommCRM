import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { getPlatformMetaAppPrivacy } from "@/lib/channels/meta/app";
import { authRateLimited } from "@/lib/auth/rate-limit";
import { MetaIntegrationError } from "./types";
import { createBoundedMetaAdminClient } from "./bounded-admin";
import { readMetaRemovalSignedRequest, verifyMetaRemovalSignature } from "./removal-signature";

export const metaDeletionCodePattern = /^[a-f0-9]{64}$/;
const privacyStatus = z.enum(["pending", "processing", "completed"]);
const requestResult = z.object({
  request_id: z.uuid(),
  confirmation_code_encrypted: z.string().min(1),
  status: privacyStatus,
});
const claimResult = z.object({
  id: z.uuid(),
  fence: z.number().int().positive(),
  lease_until: z.string(),
});
const storageObject = z
  .object({
    id: z.uuid(),
    organization_id: z.uuid(),
    publication_id: z.uuid(),
    index: z.number().int().min(0).max(9),
    path: z.string(),
  })
  .refine(
    (object) =>
      object.path ===
      `${object.organization_id}/instagram/publications/${object.publication_id}/${object.index}.jpg`,
  );
const stepResult = z.object({
  status: privacyStatus,
  more: z.boolean(),
  storage_objects: z.array(storageObject).max(100),
});

function unavailable(): MetaIntegrationError {
  return new MetaIntegrationError(
    "meta_privacy_unavailable",
    "Não foi possível concluir a solicitação de exclusão. Tente novamente.",
    503,
  );
}

export async function receiveMetaPrivacyRequest(
  request: Request,
  kind: "deauthorization" | "data_deletion",
): Promise<{ confirmationCode: string }> {
  const signedRequest = await readMetaRemovalSignedRequest(request);
  if (
    await authRateLimited("meta_privacy_callback", signedRequest, {
      ip: 300,
      id: 30,
      windowSec: 300,
    })
  )
    throw new MetaIntegrationError("rate_limited", "Aguarde antes de repetir a solicitação.", 429);
  // Fresh coherent app identity; no config_id, feature flag or environment fallback.
  const app = await getPlatformMetaAppPrivacy();
  if (!app) throw unavailable();
  const proof = verifyMetaRemovalSignature(signedRequest, app.appSecret);
  const db = createAdminClient();
  const { data, error } = await db.rpc("fn_meta_privacy_request", {
    p_app_id: app.appId,
    p_remote_actor_id: proof.remoteActorId,
    p_kind: kind,
    p_request_digest: proof.signedRequestHash,
    p_confirmation_code: randomBytes(32).toString("hex"),
    p_issued_at: proof.issuedAt,
  });
  const result = requestResult.safeParse(data);
  if (error || !result.success) throw unavailable();
  const confirmationCode = await decryptWebhookSecret(db, result.data.confirmation_code_encrypted);
  if (!confirmationCode || !metaDeletionCodePattern.test(confirmationCode)) throw unavailable();
  return { confirmationCode };
}

/** Only a random possession proof leaves the private service-role boundary. */
export async function getMetaDeletionStatus(
  code: string,
): Promise<"pending" | "processing" | "completed" | null> {
  if (!metaDeletionCodePattern.test(code)) return null;
  if (await authRateLimited("meta_privacy_status", code, { ip: 120, id: 30, windowSec: 300 }))
    throw new MetaIntegrationError("rate_limited", "Aguarde antes de consultar novamente.", 429);
  const { data, error } = await createAdminClient()
    .from("meta_privacy_requests")
    .select("status")
    .eq("confirmation_code_hash", createHash("sha256").update(code).digest("hex"))
    .eq("kind", "data_deletion")
    .maybeSingle();
  if (error) throw unavailable();
  if (!data) return null;
  const result = privacyStatus.safeParse(data.status);
  if (!result.success) throw unavailable();
  return result.data;
}

/** The durable outbox stays pending on storage failures or a lost lease. */
export async function drainMetaPrivacyRequests(
  db = createBoundedMetaAdminClient(),
): Promise<number> {
  const workerId = `meta-privacy:${randomUUID()}`;
  let progressed = 0;
  for (let request = 0; request < 2; request++) {
    const claimed = await db.rpc("fn_meta_privacy_claim", {
      p_worker_id: workerId,
      p_lease_seconds: 90,
    });
    if (claimed.error) throw unavailable();
    if (claimed.data === null) break;
    const claim = claimResult.safeParse(claimed.data);
    if (!claim.success) throw unavailable();
    let acknowledged: string[] = [];
    // Each tick is bounded; the next worker resumes from the durable receipt.
    for (let iteration = 0; iteration < 3; iteration++) {
      const step = await db.rpc("fn_meta_privacy_step", {
        p_request_id: claim.data.id,
        p_worker_id: workerId,
        p_fence: claim.data.fence,
        p_storage_object_ids: acknowledged,
        p_limit: 100,
      });
      const parsed = stepResult.safeParse(step.data);
      if (step.error || !parsed.success) throw unavailable();
      const { status, more, storage_objects: objects } = parsed.data;
      progressed++;
      if (status === "completed" || !more) break;
      if (!objects.length) break;
      const removed = await db.storage
        .from("whatsapp-media")
        .remove(objects.map((object) => object.path));
      if (removed.error) throw unavailable();
      acknowledged = objects.map((object) => object.id);
    }
  }
  return progressed;
}
