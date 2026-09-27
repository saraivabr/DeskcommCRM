# 03 — Tipografia

> **Fonte ativa:** `app/layout.tsx` carrega Manrope (`--font-interface`) e IBM Plex Mono (`--font-mono`). `app/globals.css` aplica as famílias. O showcase em `app/design/` conserva opções anteriores para comparação.

## Famílias e papéis

- **Manrope** é a fonte da interface: navegação, títulos do workspace, botões, campos e texto corrido. Use peso e espaço para indicar hierarquia.
- **Georgia** é uma opção editorial restrita a `.artisan-title` e títulos de onboarding/acesso que já usam essa linguagem. Não aplique Georgia globalmente a todo `h1`.
- **IBM Plex Mono** identifica dados tabulares, código e IDs longos. Use `font-variant-numeric: tabular-nums` também nas colunas numéricas em Manrope.

## Escala prática

| Papel | Tamanho inicial | Uso |
|---|---:|---|
| Título de página | `clamp(1.9rem, 3.2vw, 2.7rem)` | Título principal do workspace |
| Título de seção | 20–24px | Divisão de uma tarefa |
| Corpo | 16px | Explicações e texto de leitura |
| Controle | 14px | Botão, campo, aba, navegação |
| Informação auxiliar | 12–14px | Metadados com contraste legível |

Evite texto abaixo de 12px em conteúdo operacional. Em campos e rótulos, mantenha texto persistente e tamanho confortável; placeholder não substitui label. Em dados alinhados, use numerais tabulares. Truncamento deve preservar acesso ao conteúdo completo.

## Estados e leitura

- Corpo de texto deve ter entrelinha confortável; títulos podem ser mais compactos.
- `text-muted` não deve esconder erros, preços, totais, prazos ou a próxima ação.
- Teste zoom de 200%, linhas longas e 390px de largura sem corte de texto ou scroll horizontal da página.
- Cor da marca da organização não escolhe família tipográfica nem substitui cores de estado.
