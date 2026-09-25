"use client";
import { WorkspaceAssistantTrigger } from "@/components/workspace/WorkspaceAssistant";
import { AlertsBell } from "./AlertsBell";
import { MobileSidebar } from "./MobileSidebar";
import { usePathname } from "next/navigation";
import { useT } from "@/hooks/i18n/useT";
import { NAV_DESTINATIONS } from "@/lib/navigation/registry";
import { UserMenu } from "./UserMenu";
import { SearchTrigger } from "./SearchTrigger";

export function TopBar() {
  const pathname = usePathname();
  const t = useT();
  const destination = NAV_DESTINATIONS.filter(
    (item) =>
      pathname === item.href || (item.href !== "/app" && pathname.startsWith(item.href + "/")),
  ).sort((a, b) => b.href.length - a.href.length)[0];
  const title = destination?.workspace?.label ?? destination?.label;

  return (
    <header className="sticky top-0 z-20 flex h-[80px] shrink-0 items-center justify-between gap-2 border-b border-border bg-background/95 px-3 backdrop-blur-xl md:gap-4 md:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <MobileSidebar />
        {title && <span className="truncate text-xs text-muted-foreground">{t(title)}</span>}
      </div>
      <div className="flex min-w-0 flex-1 justify-center">
        <SearchTrigger />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <div className="[&_svg]:text-primary [&>button]:border-0 [&>button]:bg-transparent [&>button]:px-2 [&>button]:text-[11px] [&>button]:font-bold [&>button]:shadow-none">
          <WorkspaceAssistantTrigger />
        </div>
        <AlertsBell />
        <UserMenu />
      </div>
    </header>
  );
}
