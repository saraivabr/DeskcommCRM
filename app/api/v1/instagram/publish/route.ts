import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { publicationInput, type Publication } from "@/lib/instagram/publication-schema";
import {
  instagramContext,
  requireInstagramAccount,
} from "@/lib/channels/social/instagram-management";
import {
  publishInstagram,
  readInstagramPublication,
  findInstagramPublication,
} from "@/lib/channels/social/instagram-publishing";
import { SocialError } from "@/lib/channels/social/client";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
const headers = { "Cache-Control": "no-store" };
const columns =
  "id,account_id,item_ids,format,caption,status,provider_post_id,permalink,error,created_at";
function failure(e: unknown, requestId: string) {
  return fail(
    "instagram_publish_failed",
    e instanceof SocialError
      ? e.message
      : "Não foi possível concluir. Consulte o resultado antes de tentar novamente.",
    e instanceof SocialError ? e.status : 502,
    { requestId, headers },
  );
}
export async function GET() {
  const requestId = randomUUID();
  const auth = await requireRole("viewer", { requestId });
  if (!auth.ok) return auth.response;
  try {
    const pool = getRequestPool();
    const { rows } = await pool.query<Publication>(
      `select ${columns} from instagram_publications where organization_id=$1 order by created_at desc limit 50`,
      [auth.org.orgId],
    );
    const context = await instagramContext(createAdminClient(), auth.org.orgId);
    // Read-only upstream reconciliation; never sends content during refresh.
    const publications = await Promise.all(
      rows.map(async (row) => {
        if (!["pending", "uncertain", "sending"].includes(row.status)) return row;
        if (!context.accounts.some((a) => a._id === row.account_id)) return row;
        try {
          const found = row.provider_post_id
            ? await readInstagramPublication(context.key, row.provider_post_id, row.account_id)
            : await findInstagramPublication(
                context.key,
                context.profileId,
                row.id,
                row.account_id,
              );
          return found
            ? { ...row, ...found }
            : {
                ...row,
                status: "uncertain" as const,
                error: "Envio ainda não confirmado. Atualize o resultado; não repita a publicação.",
              };
        } catch {
          return {
            ...row,
            error: "Não foi possível atualizar o resultado. Tente atualizar novamente.",
          };
        }
      }),
    );
    return ok(
      {
        publications,
        accounts: context.accounts.map((a) => ({
          id: a._id,
          username: a.username ?? a.displayName ?? a._id,
          active: a.isActive,
        })),
        can_publish: ["manager", "admin"].includes(auth.org.role),
      },
      { requestId, headers },
    );
  } catch (e) {
    return failure(e, requestId);
  }
}
export async function POST(req: Request) {
  const requestId = randomUUID();
  const support = await requireSupportWrite();
  if (support) return support;
  const auth = await requireRole("manager", { requestId });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida())
    return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  const parsed = publicationInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail("validation_failed", "Confira as imagens, a conta e a legenda.", 400, {
      requestId,
    });
  const input = parsed.data;
  const pool = getRequestPool();
  const org = auth.org.orgId;
  let inserted = false;
  let dispatched = false;
  try {
    const previous = await pool.query<Publication>(
      `select ${columns} from instagram_publications where organization_id=$1 and id=$2`,
      [org, input.id],
    );
    if (previous.rows[0]) {
      const old = previous.rows[0];
      if (
        old.account_id !== input.account_id ||
        old.format !== input.format ||
        old.caption !== input.caption ||
        JSON.stringify(old.item_ids) !== JSON.stringify(input.item_ids)
      )
        throw new SocialError("Este envio já existe com outro conteúdo.", 409);
      if (["sending", "pending", "uncertain"].includes(old.status)) {
        const context = await instagramContext(createAdminClient(), org);
        requireInstagramAccount(context, old.account_id);
        const found = old.provider_post_id
          ? await readInstagramPublication(context.key, old.provider_post_id, old.account_id)
          : await findInstagramPublication(context.key, context.profileId, old.id, old.account_id);
        if (found) {
          await pool.query(
            "update instagram_publications set status=$3,provider_post_id=$4,permalink=$5,error=$6,updated_at=now() where organization_id=$1 and id=$2",
            [org, old.id, found.status, found.provider_post_id, found.permalink, found.error],
          );
          void audit({
            action: "instagram.completed",
            actorUserId: auth.user.id,
            organizationId: org,
            resourceType: "instagram_publication",
            resourceId: old.id,
            requestId,
            metadata: { operation: "reconcile", status: found.status },
          });
          return ok({ ...old, ...found }, { requestId, headers });
        }
      }
      return ok(old, { requestId, headers });
    }
    const limit = await checkRateLimit(`instagram-publish:${org}`, 20, 3600);
    if (!limit.allowed)
      throw new SocialError(
        "Limite de publicações atingido. Aguarde para publicar novamente.",
        429,
      );
    const admin = createAdminClient();
    const context = await instagramContext(admin, org);
    requireInstagramAccount(context, input.account_id);
    const items = await pool.query<{ id: string; asset_path: string; input: { format: string } }>(
      "select id,asset_path,input from instagram_studio_items where organization_id=$1 and id=any($2::uuid[]) and kind='post' and status='ready'",
      [org, input.item_ids],
    );
    if (items.rows.length !== input.item_ids.length)
      throw new SocialError(
        "Todas as imagens precisam estar prontas e pertencer à sua empresa.",
        422,
      );
    if (input.format === "story" && items.rows[0]?.input.format !== "story")
      throw new SocialError("Use uma imagem no formato Story.", 422);
    const claim = await pool.query(
      "insert into instagram_publications(id,organization_id,account_id,item_ids,format,caption) values($1,$2,$3,$4,$5,$6) on conflict do nothing returning id",
      [input.id, org, input.account_id, input.item_ids, input.format, input.caption],
    );
    if (!claim.rowCount)
      throw new SocialError("Publicação já em andamento. Atualize os resultados.", 409);
    inserted = true;
    const urls: string[] = [];
    for (const [index, id] of input.item_ids.entries()) {
      const item = items.rows.find((row) => row.id === id)!;
      if (!item.asset_path?.startsWith(`${org}/instagram/`))
        throw new SocialError("Imagem indisponível para esta organização.", 422);
      const storage = admin.storage.from("whatsapp-media");
      const source = await storage.download(item.asset_path);
      if (source.error || !source.data)
        throw new SocialError("Não foi possível preparar a imagem.");
      const target = `${org}/instagram/publications/${input.id}/${index}.jpg`;
      const buffer = await sharp(Buffer.from(await source.data.arrayBuffer()))
        .rotate()
        .resize(
          1080,
          input.format === "story"
            ? 1920
            : items.rows.find((row) => row.id === input.item_ids[0])?.input.format === "square"
              ? 1080
              : 1350,
          {
            fit: "contain",
            background: "#ffffff",
          },
        )
        .jpeg({ quality: 92 })
        .toBuffer();
      const uploaded = await storage.upload(target, buffer, {
        contentType: "image/jpeg",
        upsert: false,
      });
      if (uploaded.error) throw new SocialError("Não foi possível salvar a imagem preparada.");
      const signed = await storage.createSignedUrl(target, 86400);
      if (signed.error || !signed.data)
        throw new SocialError("Não foi possível autorizar o acesso à imagem.");
      urls.push(signed.data.signedUrl);
    }
    await pool.query(
      "update instagram_publications set status='sending',updated_at=now() where organization_id=$1 and id=$2",
      [org, input.id],
    );
    dispatched = true;
    const result = await publishInstagram(context.key, input, urls);
    await pool.query(
      "update instagram_publications set status=$3,provider_post_id=$4,permalink=$5,error=$6,updated_at=now() where organization_id=$1 and id=$2",
      [org, input.id, result.status, result.provider_post_id, result.permalink, result.error],
    );
    void audit({
      action: "instagram.completed",
      actorUserId: auth.user.id,
      organizationId: org,
      resourceType: "instagram_publication",
      resourceId: input.id,
      requestId,
      metadata: { status: result.status, account_id: input.account_id },
    });
    return ok({ ...input, ...result }, { requestId, headers });
  } catch (e) {
    if (inserted) {
      const uncertain =
        dispatched &&
        !(
          e instanceof SocialError &&
          e.upstreamStatus &&
          [400, 401, 403, 404, 422, 429].includes(e.upstreamStatus)
        );
      const error = uncertain
        ? "Envio ainda não confirmado. Atualize os resultados antes de tentar novamente."
        : e instanceof SocialError
          ? e.message
          : "Não foi possível preparar a publicação.";
      await pool.query(
        "update instagram_publications set status=$3,error=$4,updated_at=now() where organization_id=$1 and id=$2",
        [org, input.id, uncertain ? "uncertain" : "failed", error],
      );
      void audit({
        action: "instagram.failed",
        actorUserId: auth.user.id,
        organizationId: org,
        resourceType: "instagram_publication",
        resourceId: input.id,
        requestId,
      });
    }
    return failure(e, requestId);
  }
}
