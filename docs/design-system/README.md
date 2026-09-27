# Design System escreve.ai — Documentação Canônica

> **Versão:** v2.0 (rebranding 2026-09-27)
> **Status:** Ativa
> **Direção:** Soft-tech / calmo, anti-genérico
> **Stack visual:** Sage configurável por organização + Manrope + Georgia em títulos editoriais + IBM Plex Mono para dados + Aerada

Esta pasta descreve a linguagem visual ativa. Os tokens de produção estão em `app/globals.css` e os componentes compartilhados em `components/ui/`. O showcase em `app/design/` mantém alternativas históricas para comparação; seus tokens `--ds-*` não definem a aparência do aplicativo.

## Índice

| # | Documento | O que cobre |
|---|-----------|-------------|
| 00 | [Overview](./00-overview.md) | Filosofia, princípios, referências |
| 01 | [Foundation Tokens](./01-foundation-tokens.md) | Spacing, radius, shadow, motion, z-index |
| 02 | [Paleta Sage](./02-palette-sage.md) | 22 stops com hex (light + dark), estados, contraste |
| 03 | [Tipografia](./03-typography.md) | Manrope, títulos editoriais e IBM Plex Mono |
| 04 | [Densidade Aerada](./04-density-aerada.md) | Row 56 / gap 24, quando overrider |
| 05 | [Iconografia Phosphor](./05-iconography-phosphor.md) | Duotone, mapeamento por feature |
| 06 | [Componentes](./06-components.md) | shadcn customizado + componentes do produto |
| 07 | [Motion Language](./07-motion-language.md) | 4 tipos canônicos, curvas, durations |
| 08 | [Voz e Tom](./08-voice-and-tone.md) | PT-BR profissional calmo, microcopy |
| 09 | [Anti-patterns](./09-anti-patterns.md) | O que não fazer, com alternativas |

## Mapa decisão → source of truth

| Decisão | Onde está canonizada | Quando consultar |
|---------|----------------------|------------------|
| Cor (hex, stop, estado) | `app/globals.css` + `lib/branding/` | Sempre que precisar referenciar uma cor |
| Spacing / radius / shadow | `app/globals.css` | Toda vez que escrever CSS de layout |
| Tamanho/peso de texto | `03-typography.md` | Ao criar headers, body, dados, captions |
| Altura de linha de inbox / kanban / tabela | `04-density-aerada.md` | Ao desenhar listas e grids |
| Qual ícone usar para feature X | `05-iconography-phosphor.md` | Ao adicionar novo ícone |
| Variant/state de um componente shadcn | `06-components.md` | Antes de criar novo componente |
| Duração e curva de animação | `07-motion-language.md` | Toda vez que adicionar `transition` ou `animation` |
| Copy de erro/sucesso/empty | `08-voice-and-tone.md` | Ao escrever microcopy |
| "Posso usar X?" (Inter, gradient roxo, etc.) | `09-anti-patterns.md` | Quando em dúvida sobre uma escolha |

## Source of truth (código)

- `app/globals.css` — tokens semânticos da interface, temas claro/escuro e ponte Tailwind
- `components/ui/` — estilos e estados dos componentes compartilhados
- `app/layout.tsx` — Manrope e IBM Plex Mono via `next/font/google`
- `app/design/` — showcase de alternativas históricas, isolado em `.ds-root`

## Versionamento

- **v1.0** (2026-04-28) — proposta Sage, Atkinson, Aerada e Phosphor.
- **v2.0** (2026-09-27) — base de produção normalizada: neutros Sage únicos, tipografia Manrope com títulos editoriais, componentes responsivos e marca por organização preservada.
