import { z } from "zod";
import { socialRequest, SocialError } from "./client";
const targetSchema = z.object({
  platform: z.string(),
  accountId: z.union([z.string(), z.object({ _id: z.string() })]),
  status: z.string().optional(),
  platformPostUrl: z.string().nullish(),
  error: z.unknown().optional(),
  errorMessage: z.string().nullish(),
});
const postSchema = z.object({
  _id: z.string(),
  status: z.string(),
  platforms: z.array(targetSchema),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export function publicationResult(value: unknown, accountId: string) {
  const envelope = z
    .object({ post: postSchema.optional(), existingPost: postSchema.optional() })
    .parse(value);
  const post = envelope.post ?? envelope.existingPost;
  if (!post)
    throw new SocialError(
      "Não foi possível confirmar a publicação. Atualize o resultado antes de tentar novamente.",
    );
  const target = post.platforms.find(
    (p) =>
      p.platform === "instagram" &&
      (typeof p.accountId === "string" ? p.accountId : p.accountId._id) === accountId,
  );
  if (!target) throw new SocialError("A publicação retornada não corresponde à conta escolhida.");
  const published = target.status === "published";
  const failed = target.status === "failed" || post.status === "failed";
  let permalink: string | null = null;
  if (target.platformPostUrl) {
    const url = new URL(target.platformPostUrl);
    if (url.protocol === "https:" && /(^|\.)instagram\.com$/.test(url.hostname))
      permalink = url.toString();
  }
  return {
    provider_post_id: post._id,
    status: published ? "published" : failed ? "failed" : "pending",
    permalink,
    error: failed
      ? target.errorMessage
          ?.replace(/https?:\/\/\S+/g, "[link protegido]")
          .replace(/(?:Bearer\s+)?[A-Za-z0-9_.-]{40,}/g, "[identificador protegido]")
          .slice(0, 500) ||
        "O Instagram recusou a publicação. Confira a conexão, o formato e as permissões antes de criar um novo envio."
      : null,
  } as const;
}
export async function publishInstagram(
  key: string,
  input: { id: string; account_id: string; format: string; caption: string },
  urls: string[],
) {
  const result = await socialRequest(
    key,
    "posts",
    {
      content: input.format === "story" ? "" : input.caption,
      mediaItems: urls.map((url) => ({ type: "image", url })),
      platforms: [
        {
          platform: "instagram",
          accountId: input.account_id,
          platformSpecificData: {
            ...(input.format === "story" ? { contentType: "story" } : {}),
            isAiGenerated: true,
          },
        },
      ],
      publishNow: true,
      metadata: { studio_publication_id: input.id },
    },
    { requestId: input.id },
  );
  return publicationResult(result, input.account_id);
}
export async function readInstagramPublication(key: string, id: string, account: string) {
  return publicationResult(await socialRequest(key, `posts/${encodeURIComponent(id)}`), account);
}
export async function findInstagramPublication(
  key: string,
  profile: string,
  id: string,
  account: string,
) {
  const response = z
    .object({ posts: z.array(postSchema) })
    .parse(await socialRequest(key, `posts?profileId=${encodeURIComponent(profile)}&limit=100`));
  const post = response.posts.find((p) => p.metadata?.studio_publication_id === id);
  return post ? publicationResult({ post }, account) : null;
}
