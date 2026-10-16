-- 0425: opções de modelos; não altera padrões nem linhas já personalizadas.
-- Fonte: DeskcommCRM 262639f75; preços Standard reconferidos em 2026-10-16.
-- https://developers.openai.com/api/docs/pricing
-- O motor calcula faixas longas por requisição; o catálogo exibe a faixa curta.
insert into public.ai_models
  (provider, model_id, display_name, description, context_window,
   input_price_per_million_cents, output_price_per_million_cents, supports_tools)
values
  ('openai', 'gpt-6-luna', 'GPT-6 Luna',
   'Opção de baixo custo para atendimento e classificação.', 1050000, 10, 50, true),
  ('openai', 'gpt-6.1-sol', 'GPT-6.1 Sol',
   'Opção equilibrada de custo e capacidade.', 1050000, 200, 1000, true),
  ('openai', 'gpt-6-astra', 'GPT-6 Astra',
   'Opção de maior capacidade para tarefas complexas.', 1050000, 1000, 5000, true)
on conflict (provider, model_id) do nothing;

insert into public.ai_pricing
  (model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens, notes)
values
  ('gpt-6-luna',     10,   50, 'catálogo 0425 — acima de 272k tokens de entrada, 20/75'),
  ('gpt-6.1-sol',   200, 1000, 'catálogo 0425 — acima de 272k tokens de entrada, 400/1500'),
  ('gpt-6-astra',  1000, 5000, 'catálogo 0425 — acima de 272k tokens de entrada, 2000/7500')
on conflict (model) do nothing;
