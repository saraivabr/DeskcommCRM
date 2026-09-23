---
impacto: nada_mudou
secao: corrigido
titulo: Validação de credenciais OpenRouter passa a aceitar gateways compatíveis sem rota /key
---

Quando `OPENROUTER_BASE_URL` aponta para um gateway próprio OpenAI-compatível (LiteLLM, vLLM, proxy interno), a validação de credenciais em IA › Credenciais falhava com `provider_status_404` porque a rota `/key` é exclusiva do OpenRouter oficial. O validador agora detecta a ausência de `/key` em bases customizadas e valida a autenticidade e catálogo via `GET /models`, permitindo validar e publicar agentes contra gateways privados.

Contribuição de @webtecnica (#1376).
