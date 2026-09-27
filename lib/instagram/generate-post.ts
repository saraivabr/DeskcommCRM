import { createAdminClient } from "@/lib/supabase/admin";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { companyContext, companyLogo } from "./brand";
import { createCaption, createImage, StudioError } from "./ai";
import type { StudioInput } from "./schema";

type PostInput = Extract<StudioInput, { kind: "post" }>;

/** Generate the same saved Studio asset for the UI and the external MCP. */
export async function generateInstagramPost(org: string, input: PostInput): Promise<void> {
  const company = await companyContext(org);
  let logo;
  try {
    logo = input.use_logo ? await companyLogo(org, company) : null;
  } catch (error) {
    throw new StudioError(
      error instanceof Error ? error.message : "Não foi possível carregar o logo.",
      422,
    );
  }
  const caption =
    input.carousel && input.carousel.slide > 1 ? "" : await createCaption(org, input, company);
  const image = await createImage(org, input, company, logo);
  const path = `${org}/instagram/${input.id}.png`;
  const uploaded = await createAdminClient()
    .storage.from("whatsapp-media")
    .upload(path, image, { contentType: "image/png", upsert: false });
  if (uploaded.error)
    throw new StudioError(
      "A imagem foi gerada, mas não pôde ser salva. Fale com a equipe antes de gerar novamente.",
    );
  await getRequestPool().query(
    "update instagram_studio_items set status='ready',asset_path=$3,caption=$4,updated_at=now() where organization_id=$1 and id=$2",
    [org, input.id, path, caption],
  );
}
