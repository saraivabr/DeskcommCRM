"use client";
import { DBAOnlyNotice } from "@/components/admin/platform-admins/DBAOnlyNotice";
import {
  PlatformAdminsTable,
  PlatformAdminsTableSkeleton,
} from "@/components/admin/platform-admins/PlatformAdminsTable";
import { useAdminPlatformAdmins } from "@/hooks/useAdminPlatformAdmins";
import { useT } from "@/hooks/i18n/useT";

export function PlatformAdminsClient() {
  const t = useT();
  const { data, isLoading, isError, refetch } = useAdminPlatformAdmins();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Administradores da plataforma")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Administradores com acesso privilegiado à plataforma")}
        </p>
      </div>

      {/* T-04 Notice — proeminente, antes da tabela */}
      <DBAOnlyNotice />

      {/* Table */}
      {isLoading ? (
        <PlatformAdminsTableSkeleton />
      ) : isError ? (
        <div role="alert" className="flex flex-col items-center justify-center gap-3 rounded-lg border py-12 text-sm text-muted-foreground">
          <p>{t("Não foi possível carregar os administradores.")}</p>
          <button type="button" className="rounded-md border px-3 py-2 text-foreground focus-visible:ring-2 focus-visible:ring-ring" onClick={() => void refetch()}>
            {t("Tentar novamente")}
          </button>
        </div>
      ) : (
        <PlatformAdminsTable data={data ?? []} />
      )}
    </div>
  );
}
