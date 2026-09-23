---
impacto: nada_mudou
secao: corrigido
titulo: A atualização para de refazer no banco o que já estava pronto
---
Toda atualização reaplica o esquema do banco inteiro com o sistema no ar. Alguns trechos dele desfaziam e refaziam, a cada atualização, coisas que já estavam no formato final: a tabela de compromissos da agenda era regravada inteira, uma coluna da tabela de membros da equipe era criada e apagada, e duas proteções da agenda e do follow-up eram reconstruídas. Enquanto isso acontecia, quem usava a agenda ou fazia login podia ficar esperando, e cada passada consumia de novo recursos do banco.

Agora esses trechos conferem o banco antes e só agem quando ele ainda não chegou ao formato final. O resultado final é o mesmo de antes; a atualização só deixa de repetir esse trabalho. Nada precisa ser feito por quem opera a instalação.
