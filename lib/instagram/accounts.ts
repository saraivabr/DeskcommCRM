import { LEGACY_INSTAGRAM_PUBLICATION_PROVIDER } from "@/lib/channels/social/instagram-publishing";
import { createAdminClient } from "@/lib/supabase/admin";
import { listNativeInstagramReadAccounts } from "@/lib/channels/meta/social/instagram-read";
import { readSocialIntegration } from "@/lib/channels/social/store";
import { listSocialAccounts, socialErrorDetails } from "@/lib/channels/social/client";

export type InstagramReadAccount = {
  id: string;
  provider: "meta" | typeof LEGACY_INSTAGRAM_PUBLICATION_PROVIDER;
  connection_id?: string;
  name: string;
  active: boolean;
  insights_available: boolean;
  avatar_url?: string | null;
};
export async function instagramReadAccounts(org: string, signal?: AbortSignal) {
  const [native, legacy] = await Promise.allSettled([
    listNativeInstagramReadAccounts(org, signal),
    (async (): Promise<InstagramReadAccount[]> => {
      const config = await readSocialIntegration(createAdminClient(), org);
      if (!config) return [];
      return (await listSocialAccounts(config.key, config.profileId))
        .filter((a) => a.platform === "instagram")
        .map((a) => ({
          id: a._id,
          provider: LEGACY_INSTAGRAM_PUBLICATION_PROVIDER,
          name: a.username ?? a.displayName ?? "Instagram",
          active: a.isActive,
          insights_available: a.isActive,
          avatar_url: a.profilePicture?.startsWith("https://") ? a.profilePicture : null,
        }));
    })(),
  ]);
  const accounts: InstagramReadAccount[] = [
    ...(native.status === "fulfilled" ? native.value : []),
    ...(legacy.status === "fulfilled" ? legacy.value : []),
  ];
  const provider_errors = {
    meta:
      native.status === "rejected"
        ? {
            code: "meta_unavailable",
            message: "Não foi possível consultar a conexão Meta. Atualize em instantes.",
          }
        : null,
    legacy: legacy.status === "rejected" ? socialErrorDetails(legacy.reason) : null,
  };
  if (!accounts.length && legacy.status === "rejected") throw legacy.reason;
  if (!accounts.length && native.status === "rejected") throw native.reason;
  return { accounts, provider_errors };
}
