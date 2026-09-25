# Produção escreve.ai no IRB

Em 25/09/2026, a assinatura Azure for Students estava desativada e a VM de produção desalocada. A API impediu iniciar a VM, mas permitiu exportar seu disco por uma URL temporária de leitura. O disco original foi montado somente para leitura; a recuperação copiou o diretório físico do Postgres 17, arquivos do Storage, configuração e volumes de WhatsApp para o IRB.

- Servidor: alias SSH `irb`, IP `187.77.62.141`.
- Instalação: `/opt/escreveai`, Compose em `compose.json` (contém ambiente privado; modo 600).
- Aplicação: `escreveai-app`; banco: `escreveai-db`.
- Nginx: `/etc/nginx/sites-available/escreveai`; aplicação em `127.0.0.1:3124`, API Supabase em `127.0.0.1:8124`.
- Domínios recuperados: `os.escreve.ai`, `crm.escreve.ai`, `crm.saraiva.ai`, `db.saraiva.ai`.
- Certificados: Certbot, com renovação automática e recarga do Nginx.
- Backup após recuperação: `/opt/backups/escreveai/recovered-azure-20260925.dump`.
- Contagem inicial recuperada: 4 organizações, 1 usuário de autenticação, 151 contatos e 458 objetos registrados no Storage.

O scheduler foi restaurado. A imagem do worker foi reconstruída no commit `97f859e9`, mas permanece fora da inicialização padrão: o contêiner encontrado no disco nunca havia iniciado. Não ativar novas rotinas como parte de uma recuperação sem avaliar esse estado.

## Deploy

O workflow `deploy-production.yml` usa `PRODUCTION_SSH_HOST`, `PRODUCTION_SSH_USER`, `PRODUCTION_SSH_KEY` e `PRODUCTION_SSH_KNOWN_HOSTS`. A chave possui comando obrigatório e aceita somente uma tag hexadecimal de imagem. Não dá acesso a shell, encaminhamento de portas ou execução arbitrária.

`scripts/deploy-irb.sh` é instalado, pertencente a root, em `/opt/escreveai/deploy-live.sh`. Ele salva um dump, baixa a imagem, troca apenas a aplicação e verifica saúde e login HTTPS. Em falha, restaura a configuração anterior. O Compose e as credenciais de produção nunca entram no Git.

Os serviços anteriores do IRB foram preservados. O disco da Azure permanece como origem de recuperação; reativar a VM antiga requer cuidado para evitar dois schedulers ou duas sessões de WhatsApp concorrentes.
