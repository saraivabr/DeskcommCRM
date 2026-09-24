import { z } from "zod";
const providerId = z.string().regex(/^[a-f0-9]{24}$/);
export const automationInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    account_id: providerId,
    post_id: z
      .string()
      .regex(/^[0-9_]*$/)
      .max(100),
    keywords: z.array(z.string().trim().min(1).max(80)).min(1).max(30),
    match_mode: z.enum(["contains", "word", "exact"]),
    dm_response_template: z.string().trim().min(1).max(640),
    comment_reply: z.string().trim().max(1000).default(""),
  })
  .strict();
export const automationMutation = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      id: z.uuid(),
      rule: automationInput.refine((rule) => rule.post_id.length > 0, "Selecione uma postagem."),
    })
    .strict(),
  z.object({ action: z.literal("edit"), id: providerId, rule: automationInput }).strict(),
  z.object({ action: z.literal("toggle"), id: providerId, is_active: z.boolean() }).strict(),
]);
