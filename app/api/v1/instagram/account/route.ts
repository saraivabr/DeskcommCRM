import { randomUUID } from "node:crypto";
import { requireRole } from "@/lib/auth/require-role";
import { ok } from "@/lib/api/wrappers";
import { instagramReadAccounts } from "@/lib/instagram/accounts";
import { instagramAPIError } from "@/lib/instagram/api-error";

export const dynamic = "force-dynamic";
export async function GET() {
  const requestId = randomUUID();
  const headers = { "Cache-Control": "no-store" };
  const auth = await requireRole("viewer", { requestId });
  if (!auth.ok) return auth.response;
  try {
    const { accounts, provider_errors } = await instagramReadAccounts(auth.org.orgId);
    const account = accounts.find((a) => a.active) ?? accounts[0];
    return ok(
      {
        account: account
          ? {
              username: account.name.replace(/^@/, ""),
              avatar_url: account.avatar_url ?? null,
              active: account.active,
              provider: account.provider,
            }
          : null,
        provider_errors,
      },
      { requestId, headers },
    );
  } catch (error) {
    return instagramAPIError(error, requestId);
  }
}
