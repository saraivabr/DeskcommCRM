---
impacto: nada_mudou
secao: corrigido
titulo: Atualização aguarda os trabalhos do worker terminarem
---

O worker respeita o prazo dos trabalhos em curso e encerra após concluí-los, mesmo quando conexões internas ainda estão abertas. Isso evita que uma parada concluída seja tratada como falha e desfaça a atualização. A publicação verifica esse comportamento na própria imagem e continua recusando uma parada incompleta.
