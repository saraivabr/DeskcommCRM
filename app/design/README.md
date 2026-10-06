# `/design` — Design System Showcase

> **Nota sobre o nome da pasta:** o briefing pediu `app/_design/`, mas Next.js
> trata folders prefixados com `_` como privados (não geram rota). Para que a
> URL `/design` seja navegável, a pasta foi nomeada `app/design/` (sem
> underscore). Se preferir o prefixo, renomeia e adicione um redirect
> em `next.config.ts`.

Painel navegável e isolado para comparar a base atual com alternativas históricas.
O aplicativo usa os tokens de `app/globals.css`; este showcase mantém tokens
`--ds-*` próprios e não altera a marca configurada das organizações.

## Como rodar

```bash
pnpm dev
# acesse http://127.0.0.1:3000/design  (ou :3001 se a 3000 estiver ocupada)
```

A rota é pública (sem auth) e tem `robots: noindex`.

## Como ler

1. **Sidebar** — navegação entre 8 seções: Tokens, Paletas, Tipografia,
   Densidade, Componentes, Padrões, Motion, Iconografia.
2. **Top bar** — switcher para trocar **paleta + tipografia + densidade + tema**
   em runtime via CSS Custom Properties. Tudo persiste em
   `localStorage` sob a key `deskcomm.designshowcase.v1`.
3. **Canvas central** — seção ativa, com botões "Aplicar X" embutidos em cada
   variante para trocar diretamente do conteúdo (não só do switcher).

## Direção visual

> Soft-tech / calmo — neutros desaturados (greige/warm-gray, **não** slate/zinc),
> 1 accent forte mas não saturado, motion fluido, whitespace generoso, hierarquia
> tipográfica > decoração.

### Paletas (5)
`Sage` · `Clay` · `Mist` · `Plum` · `Olive` — cada uma com 11 stops do accent,
11 stops de neutro greige, 4 estados (success/warning/error/info), versões
**light e dark definidas separadamente** (não invertidas).

### Pareamentos tipográficos (5)
1. Manrope + IBM Plex Mono (base atual)
2. Bricolage Grotesque + Plus Jakarta Sans
3. Fraunces + Manrope
4. Atkinson Hyperlegible
5. Source Serif 4 + IBM Plex Sans

Inter / Geist / Space Grotesk **proibidos** por saturação em training data.

### Densidades (3)
- `Aerada` · row 56 / gap 24 (Notion-like)
- `Equilibrada` · row 44 / gap 16 (Things-like, default)
- `Compacta` · row 32 / gap 8 (Linear-like)

## Arquitetura

- `lib/tokens.ts` — alternativas isoladas do showcase; os tokens do produto estão em `app/globals.css`.
- `lib/fonts.ts` — fontes carregadas via `next/font/google` no boot do
  `design/layout.tsx` (escopo isolado), com IBM Plex Sans oficial versionada via
  `next/font/local`. Variáveis CSS expostas globalmente.
- `lib/variant-context.tsx` — Context React + `setProperty` na `.ds-root` para
  injetar tokens sem afetar o tema e a marca do produto. Hidrata de `localStorage`.
- `showcase.css` — todos os estilos do showcase prefixados `.ds-*`. Não interfere
  no resto do app.
- `sections/Section*.tsx` — uma por aba.
- `components/Switcher.tsx` — controle topo direito.

## Decisões notáveis

- **Default**: `Sage + Manrope + Equilibrada + Light`. O seletor permite comparar
  as alternativas sem declarar que elas estejam ativas no produto.
- **Iconografia recomendada**: Phosphor (duotone). Justificativa na seção Iconografia.
- **CSS variables, não Tailwind classes**: o showcase intencionalmente fica fora
  do tema do app para não poluí-lo antes da decisão final. Quando a variante for
  escolhida, migra-se para o `@theme inline` de `app/globals.css` com
  `var(--accent-N)` e os tokens viram parte do build. (Até o Tailwind 4 o alvo
  era `theme.extend.colors` do `tailwind.config.ts`, que não existe mais.)
