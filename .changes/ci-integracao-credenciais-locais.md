---
impacto: nada_mudou
secao: corrigido
titulo: Integração descartável prepara credenciais antes dos testes de MFA
---

O runner integrado prepara usuários e TOTP locais antes da coleta dos testes de recuperação de senha. A ausência da fixture passa a ter prova negativa no harness. O job manual de integração também fica declarado no mapa obrigatório de gatilhos, sem condição que pule a verificação.
