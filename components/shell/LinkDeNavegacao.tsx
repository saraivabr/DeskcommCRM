"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useRef,
  type ComponentProps,
  type FocusEvent,
  type PointerEvent,
  type TouchEvent,
} from "react";

/**
 * Link da casca (barra lateral, rodapé, sino, faixas) com prefetch POR INTENÇÃO.
 *
 * O `<Link>` padrão do Next antecipa todo link VISÍVEL. Na casca isso é a lista
 * inteira de portas, e cada uma é uma rota dinâmica cujo único `loading.tsx`
 * mora ABAIXO de `app/app/layout.tsx` — então todo prefetch roda o layout
 * inteiro no servidor: proxy (`getUser`), `loadAuthUser` (`getUser` + 2
 * selects + RPC) e o `Promise.all` do layout (organização, conexões caídas, MFA,
 * módulos). Medido em produção (os.escreve.ai, 2026-10-18): ~17 prefetches por
 * página aberta, e a rajada INTEIRA se repete a cada navegação ou
 * `router.refresh()` (`pingVisibleLinks` reagenda todo link visível quando a
 * árvore muda). Eram ~30 renderizações de servidor disputando o GoTrue e o
 * Postgres com as chamadas da própria tela — que por isso levavam 4–12 s.
 *
 * A rajada também é a causa das corridas já documentadas em
 * `app/app/kanban/_client.tsx`, `components/branding/CampoDeLogo.tsx` e
 * `lib/branding/instalacao.ts` (refresh descartado no meio dela).
 *
 * Aqui o prefetch acontece quando a pessoa SINALIZA que vai clicar: ponteiro
 * em cima, foco por teclado ou toque. Uma vez por destino por montagem; o cache
 * do roteador cuida da validade depois disso.
 */
type Props = ComponentProps<typeof Link>;

export function LinkDeNavegacao({ href, onPointerEnter, onFocus, onTouchStart, ...resto }: Props) {
  const router = useRouter();
  const antecipado = useRef<string | null>(null);

  function antecipar() {
    const destino = typeof href === "string" ? href : href.pathname;
    if (!destino || antecipado.current === destino) return;
    antecipado.current = destino;
    router.prefetch(destino);
  }

  return (
    <Link
      {...resto}
      href={href}
      prefetch={false}
      onPointerEnter={(evento: PointerEvent<HTMLAnchorElement>) => {
        antecipar();
        onPointerEnter?.(evento);
      }}
      onFocus={(evento: FocusEvent<HTMLAnchorElement>) => {
        antecipar();
        onFocus?.(evento);
      }}
      onTouchStart={(evento: TouchEvent<HTMLAnchorElement>) => {
        antecipar();
        onTouchStart?.(evento);
      }}
    />
  );
}
