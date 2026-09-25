import { z } from "zod";

export const pageInput = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(120),
    markdown: z.string().max(200_000),
    parent_id: z.string().uuid().nullable().default(null),
    expected_revision: z.number().int().nonnegative(),
    archived: z.boolean().default(false),
    operation_id: z.string().uuid(),
  })
  .strict();
export type PageInput = z.infer<typeof pageInput>;
export type KnowledgePage = {
  index_status?: string | null;
  index_error?: string | null;
  id: string;
  organization_id: string;
  title: string;
  markdown: string;
  parent_id: string | null;
  revision: number;
  archived: boolean;
  source_id: string;
  source_url: string | null;
  original_path: string | null;
  updated_at: string;
  updated_by: string;
  indexed_revision: number;
};
