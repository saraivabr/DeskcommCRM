"use client";
import { useTransition } from "react";
import { useUser, useAuth } from "@/hooks/auth/AuthProvider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuPortal,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/theme";
import { useHotkeys } from "react-hotkeys-hook";
import { toast } from "sonner";
import { trocarIdioma } from "@/app/actions/settings/trocarIdioma";
import { useAplicarIdioma, useIdioma } from "@/lib/i18n/IdiomaProvider";
import { IDIOMAS_VISIVEIS, idiomaVisivelPorCodigo } from "@/lib/i18n/registro";
import type { Idioma } from "@/lib/i18n/idiomas";
import { useT } from "@/hooks/i18n/useT";
import Link from "next/link";
import { SignOut, ShieldCheck, Check, Sun, Moon, MonitorPlay } from "@/lib/ui/icons";

function initials(name: string | null, email: string): string {
  if (name && name.trim()) {
    return name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0])
      .join("")
      .toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}

export function UserMenu() {
  const t = useT();
  const user = useUser();
  const { signOut } = useAuth();
  const [isPending, startTransition] = useTransition();
  const idioma = useIdioma();
  const aplicarIdioma = useAplicarIdioma();
  const idiomaAtual = idiomaVisivelPorCodigo(idioma);
  const [salvandoIdioma, startIdioma] = useTransition();
  const escolherIdioma = (novo: Idioma) => {
    if (novo === idioma) return;
    aplicarIdioma(novo);
    startIdioma(async () => {
      const resultado = await trocarIdioma(novo);
      if (!resultado.ok) {
        aplicarIdioma(idioma);
        toast.error(t("Não foi possível trocar o idioma. Tente de novo."));
        return;
      }
      // Documento novo descarta o cache de rotas que ainda carrega o idioma anterior.
      window.location.reload();
    });
  };
  const { theme, setTheme } = useTheme();
  const IconeTema = theme === "dark" ? Moon : theme === "system" ? MonitorPlay : Sun;
  useHotkeys(
    "mod+shift+l",
    () => setTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light"),
    { preventDefault: true },
    [theme],
  );

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-full border border-border bg-card p-[3px]"
            aria-label={t("Menu do usuário")}
          >
            <Avatar className="h-7 w-7 text-[10px]">
              {user.avatar_url && <AvatarImage src={user.avatar_url} alt="" />}
              <AvatarFallback>{initials(user.full_name, user.email)}</AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[220px]">
          <DropdownMenuLabel>
            <div className="flex flex-col">
              <span className="text-sm font-medium">{user.full_name ?? user.email}</span>
              <span className="truncate text-xs text-muted-foreground">{user.email}</span>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              disabled={salvandoIdioma}
              data-testid="seletor-de-idioma"
              aria-label={`${t("Idioma")}: ${idiomaAtual.nomeNativo}`}
            >
              <span>{t("Idioma")}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {idiomaAtual.rotuloCurto}
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent>
                {IDIOMAS_VISIVEIS.map(({ codigo, nomeNativo }) => (
                  <DropdownMenuItem
                    key={codigo}
                    data-testid={`idioma-${codigo}`}
                    aria-current={codigo === idioma}
                    onSelect={() => escolherIdioma(codigo)}
                  >
                    <Check size={16} aria-hidden className={codigo === idioma ? "" : "invisible"} />
                    {nomeNativo}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
          <DropdownMenuItem
            aria-label={t(`Tema: ${theme}. Cmd+Shift+L para alternar.`)}
            onSelect={(event) => {
              event.preventDefault();
              setTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light");
            }}
          >
            <IconeTema size={16} aria-hidden />
            {t("Tema")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/*
            A PORTA DO MODO ADMINISTRADOR.

            Até aqui só se chegava ao painel da instalação digitando /admin na
            barra de endereços, ou por um item chamado "Gerenciar organizações"
            escondido no seletor de organização — que leva a UMA tela do painel e
            não anuncia que existe um painel.

            Ela não entra em `lib/navigation/registry.ts` de propósito: aquele
            registro descreve a navegação do TENANT (`app/app/**`), e o teste de
            completude varre só aquela raiz — uma entrada para /admin reprovaria
            o CI como link morto. Além disso o registro não sabe expressar "só o
            dono do servidor": o campo `platform` que existe lá é um atalho que
            ABRE tudo para quem é dono, não um cadeado que restringe aos outros.
            Mesmo precedente de `VersionFooter`: porta bespoke, gate próprio.

            O rótulo diz MODO, não "admin": para quem instalou o sistema, o que
            ele quer não é "uma área chamada admin", é "ir para onde eu mexo no
            servidor" — e o subtítulo diz de que servidor se trata.
          */}
          {user.is_platform_admin && (
            <>
              <DropdownMenuItem asChild>
                <Link href="/admin" data-testid="porta-modo-administrador">
                  <ShieldCheck size={16} className="mr-2" aria-hidden />
                  <span className="flex flex-col">
                    <span>{t("Modo administrador")}</span>
                    <span className="text-xs text-muted-foreground">
                      {t("Configurar este servidor")}
                    </span>
                  </span>
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem
            disabled={isPending}
            onClick={() =>
              startTransition(async () => {
                await signOut();
              })
            }
          >
            <SignOut size={16} className="mr-2" aria-hidden />
            {t("Sair")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
