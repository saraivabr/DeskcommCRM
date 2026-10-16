# Escreve aí — espaço de trabalho

A entrada `/app` oferece uma conversa de leitura com o conteúdo do CRM, pendências pessoais com opção de equipe autorizada, indicadores independentes e atividade recente. A barra lateral separa Trabalhar, Criar e Organizar. Todas as ferramentas e a busca por teclado usam o catálogo existente, respeitando o perfil; não há remoção de rotas.

## Contratos

`WorkspaceHome` e o botão global da barra superior compartilham `WorkspaceAssistantProvider`, montado no `AppShell`. O compositor compacto da Home e o do painel lateral usam a mesma pergunta, histórico e trava de envio. Eles chamam `askWorkspace`, uma server action privada. O servidor deriva organização e papel da sessão, exige autenticação/MFA, bloqueia suporte somente leitura e aplica limite de dez perguntas por minuto por pessoa/organização. `loadWorkspaceContext` usa o cliente Supabase da sessão com RLS e filtro explícito da organização. Não usa service role para buscar conteúdo.

O recorte é declarado junto da resposta: até 20 conversas e 80 mensagens recentes, 30 oportunidades recentes, ou 12 trechos por palavras da pergunta entre 100 materiais com versão ativa. Conteúdos de Conhecimento exigem manager+. Contatos anonimizados e mensagens revogadas são excluídos da consulta de conversas. Não é uma busca semântica nem um censo de toda a operação.

A chamada passa por `runModelCall`, com orçamento e registro em `llm_calls` no propósito `workspace_question`. O modelo recebe dados como fontes não confiáveis, sem ferramentas de escrita ou envio. O servidor aceita apenas IDs de fontes consultadas e constrói os links. Não há alteração de lead, publicação de agente nem envio ao cliente.

A conversa permanece em memória enquanto a pessoa navega no aplicativo; trocar de organização, papel, usuário ou recarregar reinicia o histórico. Uma falha mantém a pergunta para nova tentativa. A consulta vazia retorna uma mensagem explícita sem chamar o modelo.

## Interface

A visão geral lê `GET /api/v1/workspace/home` com os parâmetros validados de escopo e período. Organização, pessoa e papel vêm da sessão, com os mesmos filtros e RLS das consultas anteriores. A leitura pode ser cancelada no navegador e tem prazo no servidor; o controle de cada tentativa impede que uma resposta antiga substitua a mais recente. Ao esgotar a espera, a tela apresenta uma mensagem e libera Atualizar. A recuperação não fica atrás de uma Server Action pendurada na fila de ações do navegador.

A verificação de identidade e permissões distingue sessão inválida de serviço indisponível. Falhas temporárias retornam `503 auth_unavailable`, `Retry-After: 2` e `Cache-Control: no-store`; o proxy oferece uma página de nova tentativa sem consultar o layout ou apagar o cookie. Leituras de autorização têm prazo de oito segundos. O navegador consulta `GET /api/v1/auth/session` na mesma origem a cada cinco minutos com a aba visível, também ao retornar a ela quando o intervalo venceu. Assim, o servidor pode renovar o cookie HttpOnly. Um `401` de sessão expirada leva à entrada com destino interno preservado. O cliente repete somente GET em `429/502/503/504`, até três tentativas; uma espera solicitada acima de cinco segundos devolve o erro imediatamente. POST/PATCH/PUT/DELETE não são repetidos automaticamente.

No campo de pergunta, Enter envia e Shift+Enter quebra a linha. A confirmação de composição de texto (IME) não envia a pergunta.

Manrope é a fonte da interface e IBM Plex Mono permanece para dados técnicos. A casca tem tokens neutros locais, conserva o destaque da marca e respeita o branding personalizado. Ícones Phosphor na navegação e GSAP para recolher a barra e entrar na tela. `prefers-reduced-motion` desliga os movimentos. O histórico e os controles continuam utilizáveis por teclado.

Os quatro cartões de atenção para papéis com acesso a casos mostram conversas abertas, fechamentos vencidos, casos da IA aguardando resposta humana e tarefas atrasadas. A contagem dos casos lê `agent_cases` com junção obrigatória às conversas visíveis pela RLS; o escopo pessoal exige conversa atribuída à pessoa. Quem só tem papel de visualização não vê esse cartão, pois não pode abrir a tela de casos. Erro parcial aparece como consulta indisponível, nunca como zero.

O drawer sugere o recorte pela área: Inbox → conversas, Funis → oportunidades, Conhecimento → materiais (manager+); nas demais áreas usa o espaço. A pessoa pode ajustar o recorte. Ele não presume conhecer o registro aberto ou os filtros internos da tela. As fontes ficam em uma seção recolhível com os limites da consulta e o horário em que a resposta foi recebida. Esse horário não é uma promessa de sincronização: respostas anteriores não são atualizadas automaticamente.

`VoiceInput` usa o reconhecimento de fala disponibilizado pelo navegador. A captura começa somente ao clicar em Falar, pode ser interrompida e é encerrada quando o componente sai da tela. O serviço de voz do navegador pode processar o áudio; não há upload do áudio para a aplicação, chave nova ou dependência paga obrigatória. O texto transcrito preenche o campo, nunca envia automaticamente, e a pessoa revisa antes de enviar. Durante a gravação o envio fica indisponível. Navegadores sem suporte ou sem permissão recebem uma explicação e podem continuar digitando. A consulta continua somente leitura; não há ligações ou ações autônomas.

## Checklist do sistema vivo

- Entrada: catálogo de navegação e `/app`; sessão e RLS fornecem autoridade.
- Conexões: conversa → fontes do Inbox; oportunidade → Funis; material → Conhecimento.
- Observabilidade: `llm_calls` e registro de propósitos de IA; falhas visíveis e pergunta recuperável.
- Continuidade: a pessoa confere as fontes e segue pelos fluxos existentes; a IA não altera a operação.
- Pendências operacionais: não cria tarefas ou demandas; não há novo fluxo de handoff/expiração.
- Configuração: modelo, credenciais e orçamento permanecem na configuração de IA existente; falta de configuração aparece como falha recuperável.
- Laço de retorno: erro de consulta mantém a pergunta para corrigir ou tentar novamente; a pessoa verifica a fonte. Leitura pura não cria aprendizado ou alteração automática de dados.
- Recuperação dos indicadores: `WorkspaceOverview` cancela a tentativa vencida e permite nova consulta; a rota interrompe as leituras do banco e devolve o erro de autenticação sem substituir indisponibilidade por sessão expirada.
- Mapa: `docs/architecture/escreve-workspace.architecture.json`.

## Validação local

Os testes de unidade `workspace-assistant`, `workspace-action` e `workspace-context` cobrem permissões, escopo por organização, histórico, fontes inválidas, erros, teclado/IME e ditado controlado. Voz nesses testes usa um reconhecimento simulado; não prova o serviço de voz de cada navegador. O provedor externo precisa de credencial válida para uma resposta gerada real; a suíte de unidade isola esse serviço, e não constitui prova de geração ao vivo.

`tests/journeys/ci-smoke.spec.ts` exercita a Home no navegador com sessão e banco reais do ambiente descartável do CI: consulta presa, prazo esgotado, nova tentativa e entrada após remoção dos cookies de teste. Os testes `workspace-home` cobrem também resultados tardios e cancelamento. Consulte a execução do CI da revisão para o resultado; a existência dos testes não é uma declaração de aprovação.
