# Atendimento, CRM e agenda na conexão pessoal MCP

Destino: **núcleo**. A conexão pessoal oferece operações do CRM e Inbox já existentes, usando os mesmos serviços de agenda, retorno e resposta assistida. Não depende de ativar extensão.

## Contrato

O endereço continua `/api/mcp`. OAuth anuncia `crm:write`, `agenda:read` e `agenda:write`, além dos acessos existentes. Uma conexão antiga não ganha permissões automaticamente: reconecte e selecione os novos acessos em `/app/settings/ai-connections`.

| Acesso                | Capacidades                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `whatsapp:read`       | `crm_get_attendance_context`: conversa acessível, contexto, checkpoint do atendimento e próximo passo com revisão e limites explícitos |
| `whatsapp:execute`    | `crm_generate_reply_draft`: confirmação do consumo de IA, geração assistida e rascunho persistido para revisar no Inbox                |
| `crm:read`            | Funis, leads e `crm_list_stages`                                                                                                       |
| `crm:write`           | Criar/atualizar lead e mover etapa, após confirmação                                                                                   |
| `automations:read`    | Agentes, retornos e leads em risco                                                                                                     |
| `automations:execute` | Programar/cancelar retorno, após confirmação; publicação de agente continua exclusiva de administrador                                 |
| `agenda:read`         | Tipos de evento, horários livres e compromissos                                                                                        |
| `agenda:write`        | Marcar, encontrar e marcar, remarcar, cancelar, confirmar e registrar resultado do compromisso, após confirmação                       |

As novas operações de equipe em CRM, retornos e agenda exigem gerente ou administrador **na conexão pessoal**. Papéis e contratos dos agentes internos permanecem nos handlers existentes. O contexto e rascunho respeitam a visibilidade do atendente, contato bloqueado/anonimizado e organização autenticada.

## Revisão e continuidade

A confirmação fica em `/app/settings/ai-connections` e mostra o cliente, alteração ou horário solicitado. Só a sessão humana pode aprovar. O hash vincula ferramenta e argumentos; execução é reservada uma vez e chamadas repetidas devolvem o resultado salvo. Alterar argumentos pede nova confirmação. Um prazo relativo de retorno começa na execução após aprovação, conforme o resumo mostrado.

As novas escritas pessoais exigem `operation_id` UUID: gere um identificador por ação e reutilize nas tentativas da mesma ação. Um novo pedido intencional usa outro identificador. A geração de resposta também exige `expected_reply_context_revision`, obtida em `crm_get_attendance_context.freshness`: se a conversa mudar antes da geração, releia o contexto e peça nova confirmação com a revisão atual.

O replay de um rascunho depende de a revisão e o acesso continuarem válidos. Se a conversa mudar, o contato ficar bloqueado/anonimizado ou o usuário perder acesso, a chamada recusa devolver o conteúdo anterior. A validade do vínculo ativo com a equipe é conferida em cada chamada e novamente após a geração.

O rascunho usa `generateReplyDraft` e `runAgentPreview` assistido: nenhuma mensagem ou mudança de CRM é executada pelo preview. O Inbox lê `ai_reply_drafts` e oferece edição, recusa e aprovação. O envio aprovado continua validando a revisão do contexto pelo fluxo existente. Um checkpoint de preview é análise de rascunho, não um turno operacional; a chamada deduplicada informa quando essa análise não está disponível. O retorno do MCP inclui link `/app/inbox?id=<conversa>`.

## Living System Checklist

- Entrada: OAuth pessoal → `canCallTool` → contexto de conversa ou serviços CRM/agenda/retorno com organização explícita.
- Saída: rascunho → `ReplyReviewPanel`; alteração → Funis/timeline, Agenda ou Radar de Risco.
- Atividade: `auditMcpToolCall`, aprovação `mcp.action_approved` e atividades dos handlers canônicos.
- Porta/configuração: Configurações → Conectar minha IA; Inbox/agente publicado, Agenda e retornos usam as superfícies existentes. Falta de agente ou contexto obsoleto retorna estado legível.
- Próximo passo: checkpoint e propostas → revisão no Inbox; retornos programados e Radar de Risco mantêm demandas visíveis. O preview não promete uma operação que não executou.
- Continuidade IA↔humano: rascunho/propostas com revisão → editar, aprovar ou recusar; o helper de contexto incorpora o contexto e decisão humana do atendimento.
- Retorno: aprovação/recusa de rascunho é consumida pelo fluxo assistido existente; compromisso/outcome e retorno alimentam histórico e futuras consultas. Leituras não tomam decisão autônoma.
- Mapa: `docs/architecture/mcp-atendimento.architecture.json`, com entrada e saída de cada peça.

## Verificação

`tests/unit/mcp-connection-permissions.test.ts` verifica scopes, papéis, confirmações e compatibilidade legada. Os testes de atendimento verificam recusa antes de IA, contexto limitado, rascunho sem envio e análise indisponível em cache. `tests/e2e/mcp-copilot.spec.ts` prova consentimento, confirmação na tela e operação/replay com tenant sintético local. Execute os testes de agenda/retorno e os invariantes de isolamento/autoridade ao alterar estes adapters.

Na validação de 29/09/2026, passaram o build, typecheck, lint, 140 testes direcionados, 31 testes de contexto/isolamento de fixtures, 1.476 cercas, 181 invariantes selecionados de MCP/agenda/retorno/isolamento e quatro jornadas E2E em 16,5 s. A suíte geral não ficou verde: a comparação com `e2663c494` reproduziu 47 falhas unitárias anteriores; a regressão de import de fixture foi corrigida, e o timeout de hidratação passou isoladamente. A suíte completa de banco encontrou cinco falhas fora dos adapters alterados. Os gates do CI e a revisão de produção continuam sendo exigidos para publicar.

Esta entrega cobre atendimento e CRM/agenda. Simulação comparativa de agentes, pautas derivadas de conversas e atribuição comercial completa continuam fora deste contrato.
