"use client";
import { useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { CommandPalette } from "@/components/shell/CommandPalette";

export function SearchTrigger() {
  const t = useT();
  const [open, setOpen] = useState(false);

  // `enableOnFormTags`: o atalho precisa funcionar com o cursor dentro do
  // composer do inbox, que é onde o operador passa o dia.
  useHotkeys("mod+k", () => setOpen(true), { preventDefault: true, enableOnFormTags: true });

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        aria-label={t("Buscar telas")}
        className="h-9 gap-2 rounded-lg border-0 bg-transparent px-2 text-muted-foreground shadow-none hover:bg-muted"
        onClick={() => setOpen(true)}
      >
        <Search size={14} aria-hidden />
        <kbd className="hidden rounded-sm border border-border bg-transparent px-1 py-0.5 text-[9px] md:inline">
          ⌘K
        </kbd>
      </Button>
      <CommandPalette open={open} onOpenChange={setOpen} />
    </>
  );
}
