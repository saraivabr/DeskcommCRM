"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { audit } from "@/lib/audit";

export async function approveWhatsappHistoryPlaybook(form: FormData): Promise<void> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) throw new Error("history_playbook_support_read_only");
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "org_memory" });
  if (!auth.ok) throw new Error("history_playbook_forbidden");
  const draftId = form.get("draft_id");
  const raw = form.get("content");
  if (typeof draftId !== "string" || !/^[a-f0-9-]{36}$/i.test(draftId) ||
      typeof raw !== "string" || raw.trim().length < 30 || raw.length > 10_000)
    throw new Error("history_playbook_invalid_review");
  const content = raw.trim();
  const pool = getRequestPool();
  const client = await pool.connect();
  let entryId: string | null = null;
  try {
    await client.query("begin");
    const { rows } = await client.query<{ status: string }>(
      `select status from whatsapp_history_playbook_drafts
       where id=$1 and organization_id=$2 for update`, [draftId, auth.org.orgId]);
    if (rows[0]?.status !== "draft") throw new Error("history_playbook_not_reviewable");
    const entry = await client.query<{ id: string }>(
      `insert into org_memory_entries
       (organization_id,title,body,source,status,created_by)
       values ($1,'Playbook extraído do WhatsApp',$2,'whatsapp_history','active',$3) returning id`,
      [auth.org.orgId, content, auth.user.id]);
    entryId = entry.rows[0]?.id ?? null;
    if (!entryId) throw new Error("history_playbook_memory_write");
    await client.query(
      `update whatsapp_history_playbook_drafts
       set status='approved',content=$3,memory_entry_id=$4,reviewed_at=now(),reviewed_by=$5
       where id=$1 and organization_id=$2`,
      [draftId, auth.org.orgId, content, entryId, auth.user.id]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { client.release(); }
  if (!entryId) throw new Error("history_playbook_memory_write");
  await audit({ action: "ai.org_memory_entry_created", actorUserId: auth.user.id,
    organizationId: auth.org.orgId, resourceType: "org_memory_entries",
    resourceId: entryId, requestId, metadata: { source: "whatsapp_history", draft_id: draftId } });
  revalidatePath("/app/ai/knowledge/whatsapp-history");
  revalidatePath("/app/ai/memory");
}
