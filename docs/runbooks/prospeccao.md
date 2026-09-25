# Preparação da prospecção

Destino: núcleo, extensão do adaptador de busca já distribuído. A operação comum continua igual quando a organização não usa Instagram; campanhas antigas sem `search.source` continuam no Google Maps. A origem fica no JSON `search` existente. A migration 0407 acrescenta a configuração recorrente à linha de credenciais da organização, mantendo acesso somente pelo servidor e padrão desligado.

## Fluxo instalado

`/app/prospecting` → `POST /api/v1/prospecting` → Apify → cron de prospecção → candidatos → ativação explícita da campanha → fila com limites → Inbox e funil.

A busca exige parâmetros de campanha e consome saldo apenas ao clicar em **Buscar empresas**. A ativação de abordagens é separada. A seção **Buscas automáticas** salva, desligada, a fonte, público/região, intervalo (24–720 horas), limite de execuções (1–100), itens por busca e teto total (até US$ 100). A ativação é explícita. O cron existente reserva o teto de cada busca antes da chamada externa, reutiliza o request ID persistido após interrupção e não repete uma busca com resultado incerto. Ao terminar cada lote, aguarda a frequência antes do próximo; para por erro, teto, limite de execuções ou lote sem novas empresas. O teto reservado é conservador e não representa cobrança efetiva. Reativar após parada com lote pendente exige revisar o lote e salvar uma nova configuração. Credencial salva e scheduler saudável não significam campanha pronta para enviar.

O seletor permite Google Maps ou perfis públicos do Instagram. O adaptador do Instagram usa `apify~instagram-search-scraper`, `searchType=user`, uma palavra-chave composta por segmento/região e limites de itens/gasto. Região é termo de busca, não filtro geográfico garantido. Enriquecimento é opcional. Sem telefone comercial público brasileiro válido, o perfil permanece consultável, mas não é abordado por WhatsApp. Identificadores têm prefixo `instagram:` e compartilham a deduplicação por telefone existente.

Fontes oficiais verificadas em 25/09/2026:

- [Entrada do Actor Apify](https://apify.com/apify/instagram-search-scraper/input-schema).
- [Criação de conversa Zernio](https://docs.zernio.com/messages/create-inbox-conversation): Instagram não está entre as plataformas aceitas; outras retornam `PLATFORM_NOT_SUPPORTED`. Um username coletado não concede autorização nem fornece o identificador de mensagens do Instagram.
- Respostas e automações de comentários usam a central existente em `/app/instagram`, com as regras do provedor. Esta alteração não ativa nenhuma automação social nem habilita DM fria.

## Pré-condições para envio

Chave Apify válida na organização; canal de texto elegível conectado; acesso da IA liberado para os destinatários; agente publicado automático com acesso ao funil e ferramenta de movimentação; etapas e critérios definidos; continuidade do roteador compatível; fundamento de contato registrado; limites de gasto, cadência e janela revisados. A ausência bloqueia a ação correspondente; não deve ser contornada por uma flag de capacidade.

É possível coletar apenas ou reutilizar a configuração de uma campanha para abordagem automática após cada busca, passando pela mesma ativação, guarda de envio, ritmo e atendimento existentes. Parar a recorrência também pausa o lote associado; uma busca já solicitada à Apify pode concluir.

A preparação não define oferta, preços, segmento, região ou destinatários em nome do operador. Campanhas anteriores não são modelos comerciais automaticamente aprovados para novas campanhas.

## JEV e atendimento

`lib/ai/whatsapp-history-jev.ts` usa Decisions para classificar histórico. Não participa do turno de prospecção ao vivo. `intent-classifier.ts` decide qual agente atende via `runModelCall`, mas não decide o próximo passo da conversa; apontá-lo simplesmente para JEV não entrega esse comportamento.

O encaixe limitado possível é uma decisão tipada apenas para conversas vinculadas a `prospecting_candidates`, dentro do turno e da contabilização já existentes, antes da geração de resposta. Ela precisaria ser validada contra recusa, dúvida, contexto suficiente e encaminhamento humano, sem substituir guardas de envio ou impor perguntas pendentes. **Não implementado nesta preparação.** O atendimento atual continua no motor compartilhado e no modelo publicado do agente.

## Verificação da instalação em 25/09/2026

Produção consultada em `os.escreve.ai`, revisão `9951489`. Organização Saraiva.AI: Apify `users/me` 200; Zernio `accounts` e saúde do Instagram 200, conta ativa e permissões de mensagens/comentários presentes. WAHA respondeu 200, com sessões conectadas e outras falhas. A tela Conexões indicou WhatsApp terminado em 3605 conectado, em modo de teste, sem destinatários autorizados: ainda não pode enviar a público real por IA. O scheduler tem cron de prospecção a cada minuto. Não havia campanha em execução; havia uma concluída e uma em rascunho. Nenhuma campanha, busca paga ou mensagem foi iniciada nesta verificação.

## Integração e retorno de falhas

Entrada: formulário e `search.source`. Saída: `synchronizeSearch` grava candidatos consumidos por `activateCampaign` e pelo Inbox. Auditoria: `prospecting.changed` existente. Superfície/porta: Prospecção no menu; fonte no formulário e resultados na campanha. Continuidade IA/humano e bloqueio por recusa permanecem no motor compartilhado. O cron sincroniza a busca; falhas ficam em `search_status/error`, visíveis na campanha, e POST ambíguo não é repetido automaticamente. Configuração: mesma chave cifrada por organização. Mapa: `docs/architecture/prospeccao-nativa.architecture.json` mantém entrada e saída da busca. Não foi acrescentado aprendizado automático por resultados.
