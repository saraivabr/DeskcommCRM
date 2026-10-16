import { ROLE_RANK, type ActiveOrg, type AuthUser } from "@/lib/auth/types";

/** A conta conectada pertence à empresa; só o administrador efetivo pode alterá-la. */
export function podeAdministrarEmpresa(_user: AuthUser, org: ActiveOrg): boolean {
  return ROLE_RANK[org.role] >= ROLE_RANK.admin;
}
