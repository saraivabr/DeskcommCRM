---
impacto: nada_mudou
secao: corrigido
titulo: Acesso e consultas do escreve.ai preservam sessão e deixam de repetir trabalho
---

Port seletivo do DeskcommCRM v1.82.0: links de e-mail aguardam o botão de confirmação; recuperação informa a ausência de SMTP; verificação de papel e MFA começa em paralelo, mantendo os erros temporários recuperáveis do escreve.ai. A política de MFA por perfil e prazo mantém a configuração legada e exige o fator provado antes de ser alterada.

A Inbox deixa de buscar a trava do contato duas vezes por conversa, e a coluna derivada é protegida contra alterações diretas. Índices reduzem leituras na fila e no envio; métricas de atendentes recortam o período antes de consultar o histórico, mantendo os números e a RLS. As migrations0420–0422 são próprias desta edição e não substituem suas migrations anteriores.

Fontes: commits b294ef6d0, d106c4abb, 0d03a9664, 902c31be4, a26e454ed, bc37ede6d, 03be324e3, c14c54b8a, 7c394d415, b72161cd0, 8b92355f9 e 7a640ee26 do repositório melgarafael/DeskcommCRM. Créditos e licença MIT preservados.
