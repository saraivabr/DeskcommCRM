-- 0426: opções de modelos; não altera padrões nem linhas já personalizadas.
-- Fonte: DeskcommCRM 25bd3f751; preços Standard reconferidos em 2026-10-16.
-- https://platform.claude.com/docs/en/about-claude/pricing
-- O motor calcula faixas longas por requisição; o catálogo exibe a faixa curta.
insert into public.ai_models
  (provider, model_id, display_name, description, context_window,
   input_price_per_million_cents, output_price_per_million_cents, supports_tools)
values
  ('anthropic', 'claude-haiku-5-5', 'Claude Haiku 5.5',
   'Opção de baixo custo. Acima de 100 mil tokens de entrada, a faixa longa custa cinco vezes a curta.',
   1000000, 10, 50, true),
  ('anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5',
   'Opção equilibrada de velocidade e capacidade.', 1000000, 200, 1000, true),
  ('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5',
   'Opção de maior capacidade para tarefas complexas.', 1000000, 400, 2000, true)
on conflict (provider, model_id) do nothing;

insert into public.ai_pricing
  (model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens, notes)
values
  ('claude-haiku-5-5',   10,   50, 'catálogo 0426 — acima de 100k tokens de entrada, 50/250'),
  ('claude-sonnet-5-5', 200, 1000, 'catálogo 0426'),
  ('claude-opus-5-5',   400, 2000, 'catálogo 0426')
on conflict (model) do nothing;
