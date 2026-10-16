---
impacto: nada_mudou
secao: corrigido
titulo: Recupere consultas lentas sem perder a sessão por uma falha temporária
---

A tela inicial interrompe consultas que demoram demais e libera o botão Atualizar para uma nova tentativa. Falhas temporárias na validação de acesso mostram indisponibilidade sem tratar a pessoa como deslogada; quando a sessão realmente termina, a entrada preserva a página de destino. Os campos de login só ficam disponíveis quando o formulário está pronto, evitando apagar o que foi digitado durante a inicialização. A renovação usa o cookie protegido no servidor e as operações de escrita não são repetidas automaticamente após respostas de erro. Não é necessária configuração adicional na instalação.
