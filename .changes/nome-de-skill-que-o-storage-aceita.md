---
impacto: nada_mudou
secao: corrigido
titulo: Importar uma skill recusa, já na leitura do pacote, nome que o Storage não aceita
---
O pacote de skill vira chave de objeto no Storage (`{organização}/{nome}/{versão}/{caminho}`), e o
Storage tem alfabeto próprio para nome de arquivo. Um zip com `assets/ícone.png` — ou uma skill
chamada `Relatório de vendas` — passava pela conferência do pacote e só quebrava adiante, na hora de
subir o arquivo, com um erro que não ensinava o que fazer. Agora a recusa acontece na leitura do
zip, antes de qualquer envio, e a mensagem diz qual nome está fora do alfabeto e o que usar no
lugar. Quem envia pacote com letras sem acento, números, ponto, hífen, sublinhado ou espaço não vê
diferença nenhuma.

Contribuição de @webtecnica (#1346), no passo que a #686 pedia.
