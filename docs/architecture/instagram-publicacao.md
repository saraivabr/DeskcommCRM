# Instagram: criação, publicação e resposta

```mermaid
flowchart LR
  C[Conexões OAuth por organização] --> S[Perfil social isolado]
  I[Criação com IA e animação] --> B[Biblioteca privada]
  B --> R[Revisão e carrossel]
  R --> P[Intenção de publicação persistente]
  S --> P
  P --> Z[API de publicação]
  Z --> H[Recibo e link na revisão]
  H --> A[Seleção de postagem e palavras-chave]
  S --> A
  A --> E[Executor nativo de automações]
  E --> D[Direct e resposta pública]
  E --> L[Resultados e erros na tela]
  L --> A
```

A organização vem da sessão validada. Contas e regras são conferidas contra seu perfil antes de qualquer efeito. Um envio incerto é reconciliado por metadado e nunca reenviado automaticamente. O executor social já ativo não depende da imagem dos workers locais. As mutações registram auditoria; a tela fornece o próximo passo quando a plataforma recusa uma operação.
