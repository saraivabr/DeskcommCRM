---
impacto: nada_mudou
secao: corrigido
titulo: Rodar a atualização de novo remove o aviso de manutenção que ficou preso
---

Se uma atualização era interrompida depois de pôr no ar o aviso de manutenção, o aviso ficava de pé e o CRM respondia 503 para todo mundo (site, rotinas e webhooks do WhatsApp); rodar o `update.sh` de novo dizia "Nada a atualizar" e saía sem tocar nele. Agora essa mesma saída remove o aviso preso, avisa quem está operando e diz como concluir a atualização interrompida. Medido numa VPS real, onde o CRM ficou 6h30 fora do ar por isso.

Contribuição de @gideony (#1524).
