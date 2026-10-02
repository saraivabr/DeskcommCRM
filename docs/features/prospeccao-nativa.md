# Prospecção nativa

Em **CRM → Prospecção**, um administrador configura a chave Apify, pesquisa empresas no Brasil por segmento/região e consulta dados comerciais. O adaptador usa o mesmo Actor Google Maps dos fluxos existentes. Não depende de n8n nem grava em Airtable.

A busca é paga pelo saldo da conta Apify: limite de até 100 empresas e teto de US$ 0,50 a US$ 10 por execução. A quantidade pode ser menor. O enriquecimento consulta e-mails comerciais e redes do site, sem buscar pessoas físicas ou decisores. Chave cifrada por `fn_encrypt_oauth`, indisponível aos papéis do navegador. Não existe chave obrigatória no `.env`.

## Campanha

Configure uma vez a **Apresentação e oferta**: nome da vendedora, empresa que
representa e como essa empresa ajuda seus clientes. Nas buscas seguintes, informe
o segmento e a região. A mesma vendedora adapta a linguagem e os exemplos ao
nicho, mantendo a identidade e a oferta reais. Ela se apresenta pelo nome e pela
empresa; não usa “assistente virtual” na abertura e responde com transparência se
perguntarem se é IA.

Depois da pesquisa, revise conexão, funil, etapas, oferta, critérios, ritmo e
referência real da avaliação de legítimo interesse. **Iniciar abordagens** resolve
a vendedora padrão da organização no servidor, com as capacidades canônicas de
CRM e acesso ao funil escolhido. Não há criação ou seleção de agente por campanha.
Salvar o perfil, abrir a página ou realizar uma busca não inicia abordagens.

A identidade e a oferta são capturadas na configuração da campanha. Alterar nome,
empresa ou oferta vale para novas campanhas; uma preparação interrompida conserva
seu perfil e exige a mesma configuração. Recorrências novas usam o perfil atual em
cada novo lote. Campanhas e recorrências legadas com agente explícito conservam sua
configuração até a revisão pelo operador.

A vendedora atende somente conversas vinculadas à campanha, na organização e no
canal de origem. Ela não substitui o atendimento geral nem muda o roteador do
canal. Cada turno limita as ferramentas ao funil da campanha. O Inbox distingue
esses prospects do atendimento humano e preserva os handoffs; a devolução por
prazo também reconhece as conversas da prospecção. Falhas de preparação deixam um
rascunho recuperável, sem duplicar a vendedora ou publicar uma edição concorrente.

As APIs anteriores de configuração por conversa permanecem para compatibilidade,
fora do fluxo principal da prospecção.

### Assistente de voz

O editor do agente oferece **Assistente de voz**, com configuração de ElevenLabs
Agents. A integração é opcional e usa a conta ElevenLabs da organização. A chave
fica cifrada no servidor; o navegador recebe somente uma autorização temporária
para o teste. Voz, idioma, primeira mensagem e instruções podem ser revisados.

O teste usa o microfone e o áudio do navegador. Ele não inicia chamadas para clientes
nem conecta automaticamente o assistente a chamadas WhatsApp. A configuração de
voz e a publicação do agente de texto são ações independentes. Alterações posteriores
no prompt de texto precisam ser revisadas e salvas também na configuração de voz.

A ativação cria contatos e negócios usando os handlers existentes. Telefones e identificadores de empresa são únicos por organização; contatos anteriores são preservados. Uma preparação interrompida deve ser retomada com a mesma configuração. A fila começa após um minuto e envia somente a primeira abordagem. Respostas passam pelo atendimento normal; a qualificação exige os critérios definidos pelo operador e só é contada quando a etapa do negócio muda. Encontrar uma empresa não significa qualificá-la.

### Abordagem e continuidade da conversa

A primeira mensagem apresenta o motivo comercial e o valor da oferta configurada,
com um próximo passo fácil de responder. Pode pedir permissão para explicar ou
verificar se chegou ao responsável. Os critérios de qualificação entram nas
respostas, sem virar perguntas sobre processos internos na abertura.

Nas campanhas existentes, o contexto do atendimento orienta a responder dúvidas
antes de investigar a necessidade, explicar com exemplos da oferta e convidar para
demonstração quando houver interesse. Saudação automática, menu e aviso de ausência
não comprovam interesse. A orientação é esclarecer o assunto uma única vez quando
necessário e aguardar, sem questionário ou repetição. Essas regras orientam o modelo;
não constituem um classificador determinístico de respostas automáticas.

Preços e condições dependem dos materiais disponíveis; exemplos não comprovam
resultados do prospect. Uma resposta ou contato do responsável não basta para
qualificar. Versões publicadas e instruções específicas da campanha continuam
exigindo revisão no simulador quando contradizem essa abordagem.

Há uma campanha ativa por organização, até 50 tentativas em 24 horas no conjunto das campanhas, e intervalo mínimo de cinco minutos. Falhas e envios incertos consomem o limite. A janela do número, modo de teste, versão do agente, fechamento do atendimento, recusa, pausa e intervenção humana continuam ativos. Pausar interrompe novas abordagens; uma transmissão já iniciada pode concluir.

## Operação e recuperação

- Scheduler chama `/api/v1/cron/prospecting` a cada minuto, com segredo interno. Atualize a imagem do scheduler junto da aplicação. Em desenvolvimento, `pnpm dev:crons` inclui a mesma rota.
- Busca sem confirmação nunca é repetida automaticamente: confira as execuções da Apify antes de iniciar outra.
- Envio incerto não é reenviado automaticamente. O resultado e o link do Inbox ficam na campanha para revisão.
- Erro de envio pausa a campanha. Retome depois de corrigir o agente, conexão ou atendimento; candidatos que falharam permanecem em revisão.
- Novas extrações são iniciadas manualmente. Não há recarga automática de listas ou sequência de insistência para quem não respondeu.

## Sistema vivo

Entrada: administrador e pesquisa → `prospecting_campaigns/candidates`. Saída: `createContactHandler`, `createLeadHandler`, `sendMessageHandler` e turno do agente no Inbox. Comandos emitem `prospecting.changed`; cadastro e atendimento conservam as atividades canônicas. Resultados, erros e próximos envios aparecem em `/app/prospecting`, registrado no catálogo de navegação. A falha pausa a fila e exige revisão, e o resultado da conversa altera o estado exibido. A continuidade humana e IA usa o Inbox existente. Não responder não inicia novas insistências automaticamente; o operador revisa o histórico para decidir o próximo passo.

Mapa: `docs/architecture/prospeccao-nativa.architecture.json`.

### Anonimização e nova extração

A anonimização canônica do contato também limpa telefone, endereço, e-mails,
links e enriquecimento do candidato e o retira da fila. Tokens pseudônimos,
restritos ao servidor e nunca devolvidos pela API, impedem reimportar a mesma
origem ou telefone na organização. A exclusão de dados no provedor de busca
segue o processo próprio desse provedor.

O export de dados do contato inclui a origem, os dados coletados e o estado da
abordagem dos candidatos vinculados a ele, com o mesmo escopo da anonimização.
Não inclui tokens de supressão nem autorizações internas de envio.
