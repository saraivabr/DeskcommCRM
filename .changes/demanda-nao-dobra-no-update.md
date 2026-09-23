---
impacto: nada_mudou
secao: corrigido
titulo: Atualizar a instalação não duplica mais as demandas do Radar
---

Cada atualização da VPS criava uma segunda demanda para toda conversa nova que já tinha a sua, e o Radar passava a mostrar o dobro de demandas abertas sem próximo passo (o índice de atrito também contava em dobro). A atualização agora só cria demanda para conversa que não tem nenhuma, e a duplicata que as atualizações anteriores deixaram é apagada sozinha na próxima atualização. Só sai a cópia que ninguém tocou: demanda com próximo passo, responsável, lead ou caso fica como está, e a cópia que já virou o atendimento em curso da conversa também fica, para não interromper acompanhamento nenhum. Depois de atualizar, a contagem do Radar pode cair, e o número novo é o correto.
