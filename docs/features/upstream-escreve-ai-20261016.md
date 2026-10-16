# Melhorias do Deskcomm no escreve.ai — outubro de 2026

A edição incorpora recursos selecionados da versão estável v1.82.0 de
[melgarafael/DeskcommCRM](https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.82.0).
A base desta integração é o escreve.ai `7c4e88506`. Os commits trazidos conservam
atribuição; os módulos próprios de Instagram, Meta, workspace, prospecção,
identidade, cobrança e operação continuam pertencendo à edição escreve.ai.

## Escopo das sete áreas

| Área | Alteração incorporada |
| --- | --- |
| Instagram e redes sociais | Leituras com prazo, falhas por provedor, insights do ativo Meta selecionado, ressincronização e desconexão; inscrição do Direct separa eventos do aplicativo e da Página. |
| Acesso | Confirmação por POST, recuperação com diagnóstico de SMTP e MFA por perfil/carência, mantendo os limites de espera do escreve.ai. |
| Desempenho | Pausa de consultas em abas ocultas, consultas de envio e métricas com índices e recorte antecipado por período. |
| Execução de IA | Leituras independentes em paralelo, classificadores econômicos com preço conhecido e reaproveitamento do julgamento/sentimento do turno. |
| CRM | Iniciar conversa na Inbox, tarefas no negócio/cartão, calendário do funil, campos condicionais e editor visual de automações. |
| Credenciais e modelos de IA | Login ChatGPT por empresa, catálogo da conta e novos modelos GPT/Claude; o módulo de login começa desligado e exige elegibilidade da instalação. |
| Banco externo | Lista explícita de tabelas, views e colunas permitidas, com painel administrativo e isolamento por empresa. |

O [detalhamento de IA](ia-assinatura-e-classificadores.md) registra autenticação,
renovação, limites de custo e fallback. Incluir o recurso não conecta uma conta
ChatGPT nem altera o modelo padrão dos agentes existentes.

As correções do Instagram mantêm a Meta nativa independente da indisponibilidade
do Zernio. A ativação do Direct é uma operação posterior ao deploy: confere o
callback, preserva as outras inscrições Meta e mantém a IA em `pre_go_live`.
Um callback aceito e um canal `WORKING` não provam entrega real de uma mensagem.

## Acesso

O link de e-mail abre `/login/continuar`; somente o formulário POST em
`/auth/confirm` consome o token. A tela não precisa consultar uma sessão para
mostrar o botão. Convites, recuperação e cadastro continuam seus caminhos
originais depois da confirmação. Falha temporária de Auth mantém o tratamento
recuperável do escreve.ai; não é interpretada como sessão expirada.

Em Configurações → Segurança, um administrador escolhe o perfil mínimo de MFA e
carência de 0 a 30 dias. A política legada continua válida, o prazo começa na
mudança da regra ou entrada do membro, e salvar a mesma política não reinicia o
prazo. Quem tem fator cadastrado precisa prová-lo para alterar a regra. O registro
`security.mfa_exigida`/`security.mfa_dispensada` inclui valores anteriores e novos.
Erro de leitura da política impede a decisão de acesso e permite nova tentativa.
Não há alteração automática das políticas já configuradas.

A recuperação de senha explica a falta de SMTP no modo single-server; a correção
está em Administração → E-mail. A resposta depende da instalação, nunca da
existência do endereço digitado.

## Consultas e atendimento

A aba oculta pausa o refetch de segurança da Inbox, quadro e dossiê; voltar à aba
retoma a consulta. Eventos em tempo real e regras de posse da conversa permanecem.
O envio consulta o histórico somente no replay de uma chave existente, preserva o
ledger de idempotência e procura a mensagem pela chave primária antes do formato
legado. A saúde do worker conta somente jobs ativos.

As migrations próprias 0420 e 0422 acrescentam índices e removem consultas repetidas:

- 0420: índices de send_ledger por contato, métricas por job e eventos em processamento.
- 0422: métricas de atendentes recortam candidatas pelo período antes de consultar
  mensagens. A saída e a RLS são preservadas e comparadas com a função anterior.

Estas são mudanças de leitura e indexação. Não geram mensagens nem
mudam o encaminhamento IA↔humano: a Inbox, fila e métricas são os consumidores dos
mesmos estados. Falhas de acesso e consulta continuam visíveis pelas superfícies
existentes. O mapa de entrada e saída é: mensagens → recorte por período → métricas
de atendentes; política → sessão → tela Segurança e auditoria.

A otimização de cache do controle da conversa (0421, ainda não publicada) foi
retirada da seleção após a revisão encontrar uma corrida entre criar/trocar uma
conversa e alterar a trava humana do contato. O wrapper existente continua lendo
o contato diretamente. As sete áreas do escopo permanecem representadas; essa
otimização só poderá voltar com uma solução de concorrência comprovada.

## Banco e publicação

Os números de migration do upstream colidem com migrations personalizadas e não
são reaproveitados. Cada port recebe número próprio, apêndice de baseline,
manifesto e teste. A produção recuperada não recebe o baseline inteiro: a
publicação aplica somente a lista revisada e valida seus pré-requisitos. App e
worker são imagens da edição, construídas no CI para a mesma revisão.


O pacote `scripts/upstream-release.json` fixa cada arquivo e seu SHA-256. O
pré-check consulta apenas o catálogo do PostgreSQL e recusa objetos com corpo,
permissão ou estrutura desconhecida antes de interromper o worker. O mesmo
contrato é conferido dentro da transação de instalação e depois dela. O registro
privado `escreveai_ops.schema_releases` identifica esta atualização; ele não tenta
reconstruir o histórico de migrations da instalação recuperada.

Se a transação falha, suas alterações e o registro são desfeitos juntos. Se o
problema acontece depois, na subida dos serviços, o deploy restaura as imagens e
o estado de execução anteriores; as adições compatíveis ao banco permanecem.
O dump de segurança não é restaurado automaticamente, pois isso apagaria escritas
feitas durante a operação.
