import { randomUUID } from "node:crypto";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { readSocialIntegration } from "@/lib/channels/social/store";
import { listSocialAccounts } from "@/lib/channels/social/client";

export const dynamic = "force-dynamic";
export async function GET() {
  const requestId = randomUUID();
  const headers = { "Cache-Control": "no-store" };
  const auth = await requireRole("viewer", { requestId });
  if (!auth.ok) return auth.response;
  try {
    const config = await readSocialIntegration(createAdminClient(), auth.org.orgId);
    const accounts = config ? await listSocialAccounts(config.key, config.profileId) : [];
    const account =
      accounts.find((a) => a.platform === "instagram" && a.isActive) ??
      accounts.find((a) => a.platform === "instagram");
    return ok(
      {
        account: account
          ? {
              username: (account.username ?? account.displayName ?? "Instagram").replace(/^@/, ""),
              avatar_url: account.profilePicture?.startsWith("https://")
                ? account.profilePicture
                : null,
              active: account.isActive,
            }
          : null,
      },
      { requestId, headers },
    );
  } catch {
    return fail("instagram_unavailable", "Não foi possível consultar sua conta.", 502, {
      requestId,
      headers,
    });
  }
}
