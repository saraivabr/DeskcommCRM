# Redes sociais — recuperação e desconexão

A aba Redes sociais de Conexões permite ressincronizar o webhook após troca de domínio, remover uma conta do atendimento, desconectar a conta do provedor e desvincular o perfil da organização. As ações passam pela sessão administrativa, suporte com escrita, MFA, limite de chamadas e auditoria. Destino: núcleo, porque completa o ciclo de vida das conexões existentes. Sem migration ou nova credencial; o provisionamento central por organização continua disponível.

Ressincronizar procura a assinatura pelo caminho do token do canal pertencente à organização, muda apenas URL e ativação e relê o provedor para confirmar ambos. Não cria canal, não modifica agentes publicados, segredo ou eventos. Uma assinatura já correta e ativa é no-op. Uma assinatura desativada que já aponta para o domínio atual exige investigação e não é religada às cegas.

Remover do atendimento e desconectar pedem confirmação que identifica a conta. Primeiro removem a assinatura no provedor, pelo ID salvo ou pelo caminho do token se o ID faltar; só depois arquivam o canal e rotacionam o token. Desconectar também remove a conta, exclusivamente quando ela aparece no perfil da organização. Conversas permanecem no CRM. Falha do provedor preserva o canal; DELETE404 é tratado como remoção já concluída. Uma nova tentativa converge e nenhuma escrita é repetida automaticamente pelo cliente.

A tela expõe canais cuja conta saiu do perfil, permitindo retirar a assinatura e arquivar a linha órfã. Desvincular perfil recusa enquanto existir canal social ativo. Ao concluir, remove somente a integração da organização e fecha avisos de saúde em melhor esforço, com resultado na auditoria. Credencial salva continua sincronizada nos canais ativos e arquivados. A edição não possui o subsistema de avisos de pausa do upstream; essa dependência não foi importada.

O DELETE genérico da Central de Conexões também tenta remover a assinatura antes de apagar ou arquivar o canal social. Ele mantém o contrato anterior de melhor esforço dessa Central: ausência da integração ou falha remota fica no log e no campo `social_webhook` da auditoria. Isso pode exigir limpeza posterior no provedor. A ação dedicada da aba Redes sociais é mais estrita e preserva o canal quando a remoção remota falha.

Entrada: Conexões → Redes sociais e DELETE da Central. Saída: assinatura confirmada ou removida, canal arquivado com histórico, ou perfil desvinculado. Registro: `channel.social_webhook_ressincronizado`, `channel.social_disconnected`, `channel.social_desvinculado` e metadata do DELETE. Recuperação: erro visível, mesma conta, nova ação explícita; sucesso relê a lista. Nenhuma publicação, mensagem ou automação é disparada por essas ações. Mapa vivo: `docs/architecture/redes-sociais.architecture.json`.

Porte selecionado de `refs/deskcomm-audit/upstream-v1.82.0`, incluindo ressincronização v1.81/PR2867 e limpeza de assinaturas/canais órfãos. Preservados o provisionamento central, contrato de quota da edição, transporte sem redirect de credenciais e erros seguros por categoria.

Contratos consultados em 16/10/2026: [PUT parcial de webhook](https://docs.zernio.com/webhooks/update-webhook-settings) e [desconexão de conta e repetição404](https://docs.zernio.com/accounts/delete-account). Os testes usam provedor simulado: nenhuma conta ou assinatura real foi alterada nesta implementação.

Provas locais: testes de domínio antigo, leitura posterior divergente, assinatura desativada, token de outro canal, DELETE404, falha sem arquivamento, preservação do histórico, perfil ativo bloqueado, quota/RBAC/MFA e confirmação na interface. QA de navegador e conectividade real pertencem à integração/release e não são declarados concluídos por estes testes.
