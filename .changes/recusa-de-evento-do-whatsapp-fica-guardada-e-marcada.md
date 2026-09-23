---
impacto: nada_mudou
secao: corrigido
titulo: Evento do WhatsApp que chega num formato inesperado fica guardado e marcado como recusado
---
Quando o WhatsApp manda um evento num formato que o CRM não reconhece, o CRM recusa o evento e guarda uma cópia dele para quem for investigar. Isso tinha três falhas. No endereço de recebimento próprio de cada número, um campo que esse endereço nem usa podia fazer o evento ser recusado antes de a cópia ser guardada, e ela se perdia. Quando a cópia era guardada, ficava marcada como "recebida", igual a um evento que deu certo, e depois ninguém conseguia separar um do outro. E um evento malformado, que qualquer pessoa pode mandar antes de o CRM conferir a assinatura, aparecia no registro do servidor como erro.

Agora a cópia é guardada nesses casos, a recusa fica marcada como erro junto com os nomes dos campos que vieram diferentes (nunca o conteúdo, que é dado do cliente), e a recusa que acontece antes da assinatura aparece no registro como aviso. Mensagens no formato normal seguem entrando exatamente como antes.
