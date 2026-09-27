"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useT } from "@/hooks/i18n/useT";
import { InboxList } from "./_components/InboxList";

export default function AdminInboxLayout({ children }: { children: ReactNode }) {
  const t = useT();
  const params = useParams();
  const conversaAberta = typeof params?.conversationId === "string";

  return (
    <div className="flex h-full w-full overflow-hidden">
      <aside className={`${conversaAberta ? "hidden" : "flex w-full"} h-full min-w-0 flex-col border-r border-border xl:flex xl:w-[360px] xl:shrink-0`}>
        <InboxList />
      </aside>

      <div className={`${conversaAberta ? "flex" : "hidden"} min-w-0 flex-1 flex-col overflow-hidden xl:flex`}>
        {conversaAberta ? (
          <Link
            href="/admin/inbox"
            className="border-b border-border px-4 py-3 text-sm font-medium text-primary xl:hidden"
          >
            ← {t("Voltar às conversas")}
          </Link>
        ) : null}
        {children}
      </div>
    </div>
  );
}
