import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listSocialAccounts, socialRequest, SocialError } from "./client";
import { readSocialIntegration } from "./store";

export const socialId = z.string().regex(/^[a-f0-9]{24}$/);
export const publishedPostSchema = z.object({
  id: z.string().min(1),
  message: z.string().default(""),
  permalink: z.string().optional(),
  picture: z.string().optional(),
  mediaType: z.string().optional(),
});
export const automationSchema = z.object({
  id: socialId,
  accountId: socialId,
  name: z.string(),
  platform: z.literal("instagram"),
  platformPostId: z.string().nullish(),
  postTitle: z.string().nullish(),
  keywords: z.array(z.string()),
  matchMode: z.enum(["contains", "word", "exact"]),
  dmMessage: z.string(),
  commentReply: z.string().nullish(),
  isActive: z.boolean(),
  stats: z
    .object({
      triggered: z.number().default(0),
      dmsSent: z.number().default(0),
      dmsFailed: z.number().default(0),
      read: z.number().default(0),
    })
    .default({ triggered: 0, dmsSent: 0, dmsFailed: 0, read: 0 }),
});
export const automationLogSchema = z.object({
  id: z.string(),
  commentText: z.string().optional(),
  commenterName: z.string().optional(),
  status: z.string(),
  error: z.string().nullish(),
  commentReplyStatus: z.string().optional(),
  commentReplyError: z.string().nullish(),
  createdAt: z.string(),
});
export type InstagramAutomation = z.infer<typeof automationSchema>;
export type InstagramPost = z.infer<typeof publishedPostSchema>;
export type InstagramAutomationLog = z.infer<typeof automationLogSchema>;

export async function instagramContext(db: SupabaseClient, org: string) {
  const config = await readSocialIntegration(db, org);
  if (!config) throw new SocialError("Conecte seu Instagram em Conexões para continuar.", 422);
  const accounts = (await listSocialAccounts(config.key, config.profileId)).filter(
    (a) => a.platform === "instagram",
  );
  return { ...config, accounts };
}
export function requireInstagramAccount(
  context: Awaited<ReturnType<typeof instagramContext>>,
  id: string,
) {
  const account = context.accounts.find((a) => a._id === id);
  if (!account) throw new SocialError("Conta não encontrada nesta organização.", 404);
  if (!account.isActive)
    throw new SocialError("Reconecte esta conta do Instagram para continuar.", 422);
  return account;
}
export async function instagramPosts(key: string, accountId: string) {
  return z
    .object({ posts: z.array(publishedPostSchema) })
    .parse(await socialRequest(key, `accounts/${accountId}/posts`)).posts;
}
export async function instagramAutomations(context: Awaited<ReturnType<typeof instagramContext>>) {
  const result = z
    .object({ automations: z.array(z.object({ platform: z.string() }).passthrough()) })
    .parse(
      await socialRequest(
        context.key,
        `comment-automations?profileId=${encodeURIComponent(context.profileId)}`,
      ),
    );
  return result.automations
    .filter((a) => a.platform === "instagram")
    .map((a) => automationSchema.parse(a))
    .filter((a) => context.accounts.some((account) => account._id === a.accountId));
}
