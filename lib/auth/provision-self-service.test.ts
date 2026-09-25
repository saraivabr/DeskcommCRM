import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  membership: null as { organization_id: string } | null,
  rpc: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: h.rpc,
    from: (table: string) => {
      if (table !== "user_organizations") throw new Error("unexpected direct provisioning write");
      const chain = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: h.membership, error: null }),
      };
      return chain;
    },
  }),
}));
import { ensureTenantForUser } from "./provision";

beforeEach(() => {
  h.membership = null;
  h.rpc.mockReset();
  h.audit.mockReset();
});
const user = {
  id: "owner-id",
  email: "owner@invariant.test",
  user_metadata: { org_name: "Minha Loja" },
};
const result = { organization_id: "org-id", organization_slug: "minha-loja", provisioned: true };
function reply(data: typeof result | null, error: { code: string; message: string } | null = null) {
  return { single: async () => ({ data, error }) };
}
it("signup and recovery use the atomic Free provisioning RPC with the verified user", async () => {
  h.rpc.mockReturnValue(reply(result));
  expect(await ensureTenantForUser(user, { source: "recovery" })).toEqual({
    provisioned: true,
    organizationId: "org-id",
  });
  expect(h.rpc).toHaveBeenCalledWith("fn_provision_self_service_tenant", {
    p_slug: "minha-loja",
    p_name: "Minha Loja",
    p_owner: user.id,
  });
  expect(h.audit).toHaveBeenCalledWith(
    expect.objectContaining({ action: "tenant.created_by_recovery", organizationId: "org-id" }),
  );
});
it("existing membership and a concurrent replay preserve the existing commercial account", async () => {
  h.membership = { organization_id: "existing" };
  expect(await ensureTenantForUser(user)).toEqual({
    provisioned: false,
    organizationId: "existing",
  });
  expect(h.rpc).not.toHaveBeenCalled();
  h.membership = null;
  h.rpc.mockReturnValue(reply({ ...result, provisioned: false }));
  expect(await ensureTenantForUser(user)).toEqual({ provisioned: false, organizationId: "org-id" });
  expect(h.audit).not.toHaveBeenCalled();
});
it("only slug conflicts retry; atomic failures propagate without a partial fallback", async () => {
  h.rpc
    .mockReturnValueOnce(reply(null, { code: "23505", message: "slug occupied" }))
    .mockReturnValueOnce(reply(result));
  expect(await ensureTenantForUser(user)).toEqual({ provisioned: true, organizationId: "org-id" });
  expect(h.rpc).toHaveBeenCalledTimes(2);
  h.rpc
    .mockReset()
    .mockReturnValue(reply(null, { code: "P4022", message: "classification unavailable" }));
  await expect(ensureTenantForUser(user)).rejects.toThrow("classification unavailable");
  expect(h.rpc).toHaveBeenCalledTimes(1);
});
