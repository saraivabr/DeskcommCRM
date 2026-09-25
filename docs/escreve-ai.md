# escreve.ai — identidade e operação

## Repositório e versões

- Repositório de trabalho e produção: [saraivabr/DeskcommCRM](https://github.com/saraivabr/DeskcommCRM).
- `main`: destino da consolidação e base para novos trabalhos depois do merge.
- `feat/saraiva-ai-consolidacao`: branch de integração do [PR #2](https://github.com/saraivabr/DeskcommCRM/pull/2).
- Produção: [os.escreve.ai](https://os.escreve.ai), hospedada no IRB; operação e recuperação em [Produção no IRB](recovery/producao-irb-20260925.md).
- Confira a revisão publicada em `/api/v1/health` e compare com o SHA no GitHub. PR aberto não significa merge nem publicação.

## Origem e licença

Baseado no [DeskcommCRM](https://github.com/melgarafael/DeskcommCRM), de Rafael Melgaço e colaboradores. A [licença MIT](../LICENSE), os créditos e o histórico Git são preservados.

Changelogs, handoffs, planos, relatórios e fragmentos de releases anteriores são registros históricos. Neles, DeskcommCRM e Saraiva identificam o projeto ou a instalação na época. Links para issues, commits e PRs do projeto original continuam apontando para sua fonte verdadeira.

## Desenvolvimento e contribuição

Clone a edição e crie uma branch de trabalho a partir da `main` atualizada:

```bash
git clone https://github.com/saraivabr/DeskcommCRM.git
cd DeskcommCRM
git switch -c codex/minha-alteracao
```

Abra PRs contra `main`. Preserve alterações locais em outros worktrees e não misture implementações alternativas sem revisão.

Mantenha o upstream separado:

```bash
git remote add upstream https://github.com/melgarafael/DeskcommCRM.git
git fetch upstream
```

Em clones existentes, atualize apenas o remote que apontava para `saraivabr/saraiva-crm`; preserve outros remotes e alterações locais. Consulte [contribuição](../CONTRIBUTING.md) e [arquitetura](../ARCHITECTURE.md) para os contratos técnicos.

## Instalação e atualização

Os scripts em `hostgator-setup-kit/` são herdados do projeto original. URLs de instaladores, imagens Docker, releases e atualizadores que apontam para `melgarafael/DeskcommCRM` instalam ou atualizam a distribuição original; não garantem as personalizações escreve.ai.

Para distribuir esta edição, é necessário compilar a revisão escolhida, selecionar a imagem própria e validar banco, workers e canais antes de atualizar uma instalação. A aplicação usa a imagem `ghcr.io/saraivabr/deskcomm-app:<sha>`. As GitHub Actions executam CI, E2E e build. O deploy exige sucesso dessas verificações e da validação das imagens para a mesma revisão antes de publicar no IRB. O script salva backup e reverte a aplicação se a saúde falhar.

Parcerias, SLAs, badges de CI e promessas de publicação descritos em documentos herdados pertencem ao projeto original, salvo configuração explícita desta edição.

## Marca e compatibilidade

A identidade exibida pelo CRM é configurada pelos mecanismos de branding existentes; consulte [white-label](white-label.md). O novo domínio foi configurado separadamente da renomeação do repositório. A identidade de cada organização continua configurável.

Nomes de pacotes, caminhos, scripts `deskcomm-*`, cookies, cabeçalhos de assinatura, imagens, variáveis e identificadores persistidos permanecem quando são contratos técnicos. Não os renomeie por substituição textual: isso pode quebrar integrações, sessões e atualizações.

## Mapa da documentação

- [Índice técnico](index.md)
- [Visão do produto](../VISION.md)
- [Arquitetura](../ARCHITECTURE.md)
- [Estado de implementação](current-state.md)
- [Espaço de trabalho conversacional](features/escreve-workspace.md)
- [Prospecção nativa](features/prospeccao-nativa.md)
- [Segurança](../SECURITY.md)
- [Contribuição](../CONTRIBUTING.md)

## Endereço de produção

A instalação em produção usa **https://os.escreve.ai** (com suporte e redirecionamento contínuo para quem acessar pelo endereço legado `crm.escreve.ai`). As páginas de acesso e navegação preservam caminho e parâmetros. APIs e callbacks no endereço anterior permanecem disponíveis para integrações existentes.

O Supabase continua em `db.saraiva.ai`. O login tem a URL principal atualizada e mantém os callbacks antigos permitidos. A mudança de domínio exige entrar novamente no navegador: sessões não são compartilhadas entre os dois domínios.

Antes de reconectar provedores externos que usem OAuth, confira as URLs de callback cadastradas no provedor. A troca de domínio não atualiza automaticamente consoles de terceiros.

O logo está em [docs/brand/escreve-ai-logo.png](brand/escreve-ai-logo.png), com [notas de criação](brand/escreve-ai.md).
