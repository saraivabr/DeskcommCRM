---
impacto: nada_mudou
secao: corrigido
titulo: Extensão removida deixa de aparecer como instalada no painel do dono do servidor
---

Remover uma extensão marca a instalação como removida, mas a linha continua no banco. A tela `/admin/extensoes` lia todas as linhas, então uma extensão já removida seguia listada como instalada, junto com a contagem de empresas dela. Agora a tela ignora as instalações removidas, do mesmo jeito que o restante do sistema de extensões já fazia.
