# Produção escreve.ai no IRB

Em 25/09/2026, a assinatura Azure for Students estava desativada e a VM de produção desalocada. A API impediu iniciar a VM, mas permitiu exportar seu disco por uma URL temporária de leitura. O disco original foi montado somente para leitura; a recuperação copiou o diretório físico do Postgres 17, arquivos do Storage, configuração e volumes de WhatsApp para o IRB.

- Servidor: alias SSH `irb`, IP `187.77.62.141`.
- Instalação: `/opt/escreveai`, Compose em `compose.json` (contém ambiente privado; modo 600).
- Aplicação: `escreveai-app`; banco: `escreveai-db`.
- Nginx: `/etc/nginx/sites-available/escreveai`; aplicação em `127.0.0.1:3124`, API Supabase em `127.0.0.1:8124`.
- Domínios recuperados: `os.escreve.ai`, `crm.escreve.ai`, `crm.saraiva.ai`, `db.saraiva.ai`.
- Certificados: Certbot, com renovação automática e recarga do Nginx.
- Nginx usa `proxy_buffer_size 128k`, `proxy_buffers 4 256k`, `proxy_busy_buffers_size 256k` e `large_client_header_buffers 4 32k` para aceitar a renovação dos cookies de autenticação. Sem esses buffers, a sessão autenticada retornava 502 apesar do health check saudável.
- A URL Postgres com usuário de tenant (`postgres.<tenant>`) aponta para `supavisor:5432`; não deve apontar diretamente para `db:5432`.
- Backup após recuperação: `/opt/backups/escreveai/recovered-azure-20260925.dump`.
- Contagem inicial recuperada: 4 organizações, 1 usuário de autenticação, 151 contatos e 458 objetos registrados no Storage.

O scheduler foi restaurado. Na recuperação de 25/09, a imagem do worker foi reconstruída no commit `97f859e9` e o contêiner encontrado no disco ainda não havia iniciado. Na inspeção de 01/10, o worker já estava ativo com essa revisão; esse estado observado deve ser preservado na atualização. Confira o estado no servidor antes de qualquer troca: não ative um worker que esteja parado apenas para completar um deploy.

## Deploy

O workflow `deploy-production.yml` usa `PRODUCTION_SSH_HOST`, `PRODUCTION_SSH_USER`, `PRODUCTION_SSH_KEY` e `PRODUCTION_SSH_KNOWN_HOSTS`. A chave possui comando obrigatório e aceita exatamente três valores: SHA completo de 40 caracteres hexadecimais, digest `sha256` do app e digest `sha256` do worker. O wrapper versionado `scripts/deploy-irb-command.sh`, instalado em `/usr/local/sbin/escreveai-deploy-ssh`, valida toda a linha antes de chamar o script por `sudo`, sem avaliar texto como código. A chave não dá acesso a shell, encaminhamento de portas ou execução arbitrária.

O workflow constrói candidatas `linux/amd64` do app e do worker pelo mesmo SHA completo. Confere digest, label OCI `revision` e `APP_VERSION` nas duas imagens. A candidata do worker carrega o laço do `event_log`, os imports da prospecção e o CMD canônico em sondas com rede desativada e credenciais sintéticas; o boot só é aceito ao parar na recusa esperada do banco isolado. Nenhuma sonda alcança provedores, WhatsApp ou banco de produção.

`scripts/deploy-irb.sh` é instalado, pertencente a root, em `/opt/escreveai/deploy-live.sh`. Ele salva um dump e a configuração anterior, baixa os dois digests aprovados e confere novamente suas revisões. Extrai a migration aditiva 0415 da imagem do worker por `docker create`/`docker cp`, sem iniciar esse contêiner. Para o worker já ativo, aguarda a parada gradual e exige saída 0 antes do SQL; timeout, OOM ou interrupção abortam e restauram o estado anterior. Antes da parada, confere a assinatura, retorno booleano, `SECURITY DEFINER`, `search_path` vazio e permissões da função. Se estiver ausente, instala somente essa migration com `psql -X -1 -v ON_ERROR_STOP=1`; usa `CREATE` sem substituição para abortar uma corrida com instalação concorrente. Se já existir e o contrato for compatível, preserva sua definição, inclusive futuras correções. Contrato incompatível bloqueia antes da parada. Confere novamente o contrato após o commit e pede recarga do schema do PostgREST. Essa instalação recuperada não possui um ledger confiável de migrations: não aplique o baseline inteiro ou todas as migrations como atalho de deploy.

A troca altera somente as imagens por digest e `APP_VERSION` de `app` e `worker`; comandos, ambientes restantes, scheduler e serviço de voz são preservados. Confirma saúde e versão do app, login HTTPS, identidade da imagem do worker e `/healthz` com banco disponível e laço do `event_log` carregado. Se o worker já estava parado, continua parado. Um trap cobre falhas e sinais após a parada, restaura as duas imagens e o estado de execução anterior. A função 0415 permanece instalada em rollback por ser aditiva; o dump não é restaurado automaticamente, pois isso apagaria gravações realizadas durante a atualização. O Compose e as credenciais de produção nunca entram no Git.

Os serviços anteriores do IRB foram preservados. O disco da Azure permanece como origem de recuperação; reativar a VM antiga requer cuidado para evitar dois schedulers ou duas sessões de WhatsApp concorrentes.

A entrega automática exige o workflow `ci-rapido.yml` concluído com sucesso para o mesmo SHA, evento `push` e branch `main`, além da construção e das sondas das duas candidatas acima. A suíte completa e os demais workflows manuais continuam disponíveis sob demanda e não são descritos como gates automáticos. Falha, cancelamento, resultado ausente ou tempo esgotado no gate impedem a promoção e o deploy. Antes do SSH, o workflow ainda confere se o SHA continua no topo da `main`. Promove as duas tags SHA a partir dos digests medidos e passa esses mesmos digests ao servidor. O smoke público confere saúde **e versão**; `deskcomm-app:latest` e `deskcomm-worker:production-latest` só são atualizados depois da confirmação. O ponteiro genérico `deskcomm-worker:latest` pertence ao workflow de distribuição e permanece independente; o IRB usa os digests, sem depender dessas tags móveis.

Na consolidação da PR #2, os arquivos de migrations do fork receberam os sufixos livres 0400 (Instagram Studio), 0401 (missões de voz) e 0402 (Growth/auditoria). Seus timestamps e conteúdos SQL foram preservados; as identidades já aplicadas no Supabase não mudaram. Os sufixos 0321–0323 conflitavam com migrations recebidas do upstream.

O chat com efeitos de atividade e Enter para enviar foi incorporado da área `melhoria-no-chat-com-IA`. A implementação alternativa de Meta nativa, ainda não commitada na cópia Orca principal, permanece preservada naquela área e fora desta entrega com Zernio.
