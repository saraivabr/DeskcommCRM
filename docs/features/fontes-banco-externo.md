# Fontes permitidas no banco externo

Port seletivo dos PRs oficiais [#2634](https://github.com/melgarafael/DeskcommCRM/pull/2634), [#2635](https://github.com/melgarafael/DeskcommCRM/pull/2635) e [#2940](https://github.com/melgarafael/DeskcommCRM/pull/2940), fixados no DeskcommCRM v1.82.0 (`2caceb1c`). A correção de nomes de tabela preserva a caixa real do catálogo. Não importa o filtro opcional por cliente do atendimento, nem altera o contexto MCP desta edição.

Na lista **Integração de dados**, abrir uma conexão dá acesso ao painel “O que o assistente pode ver”. Administradores escolhem tabelas, views, colunas e descrições; demais membros consultam a seleção sem alterá-la. Uma conexão nova leva ao painel e começa sem fontes permitidas. Conexões anteriores preservam o acesso existente até uma escolha explícita.

A API de fontes valida a lista, resolve a organização na sessão e audita somente modo e contagem. A grade e as ferramentas `crm_describe_external_data`/`crm_query_external_data` passam pelo mesmo dialeto, que restringe catálogo, projeção, filtros e ordenação. Lista inválida fecha a leitura. Catálogo indisponível mantém a seleção salva e permite tentar novamente; fontes desaparecidas são identificadas no painel. O catálogo completo exige administrador.

Destino: núcleo, como evolução do conector já distribuído. Entrada: lista de conexões → painel; saída: grade e ferramentas existentes. Retorno de falha: mensagens do explorador/painel e estado da conexão permitem testar e corrigir a fonte. Auditoria: `external_db_sources.updated`. O mapa `docs/architecture/banco-de-dados-externo.architecture.json` representa a configuração, o dialeto e seus consumidores.

A migration aditiva 0430 mantém as políticas de isolamento da conexão e a view `security_invoker`. Provas: testes colocados junto da API, dialeto, ferramentas e painel; invariante `tests/invariants/banco-externo-fontes-isolamento.test.ts` usa os papéis reais de duas empresas; jornada `tests/e2e/integracao-dados-fontes-liberadas.spec.ts` persiste fontes pela API real e simula apenas o catálogo remoto. A execução DB/E2E depende do ambiente descartável de CI; não é prova de implantação.
