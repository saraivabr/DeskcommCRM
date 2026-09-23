---
impacto: nada_mudou
secao: corrigido
titulo: Textos longos sem espaços no Inbox não estouram mais a largura da tela
---

No Inbox, mensagens com sequências longas e contínuas de caracteres sem espaço (como códigos Pix copia-e-cola de 150+ caracteres) estufavam a bolha de mensagem para além da coluna de conversa, desalinhando o layout e ocultando os botões de ação do topo. A coluna da conversa, o scroller e a bolha ganharam contenção de largura mínima, e o texto ganhou quebra forçada (`wrap-anywhere`): o layout fica íntegro no desktop (medido em 1024 e 1280 px).

Contribuição de @webtecnica (#1508); relato de @tec7alex (#1451).
