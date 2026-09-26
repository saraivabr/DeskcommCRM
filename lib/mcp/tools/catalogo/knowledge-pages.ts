import { declararTools } from "./tipos";
export const TOOLS_KNOWLEDGE_PAGES = declararTools([
  {
    name: "knowledge_archive_page",
    category: "write",
    rotulo: "Arquivar uma página da equipe",
    explicacao:
      "Solicita sua confirmação para mover uma página à lixeira e retirar seu conteúdo da busca.",
    oQueToca: "Conhecimento compartilhado",
    risco: "critico",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "knowledge_list_pages",
    category: "read",
    rotulo: "Listar páginas da equipe",
    explicacao:
      "Lista as páginas compartilhadas e informa a revisão e o estado do índice de cada página.",
    oQueToca: "Conhecimento compartilhado",
    risco: "seguro",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "knowledge_read_page",
    category: "read",
    rotulo: "Ler uma página da equipe",
    explicacao:
      "Lê o conteúdo de uma página compartilhada e retorna sua revisão e o link para a interface.",
    oQueToca: "Conhecimento compartilhado",
    risco: "seguro",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "knowledge_search",
    category: "read",
    rotulo: "Pesquisar o conhecimento da equipe",
    explicacao:
      "Encontra trechos nas páginas compartilhadas e mostra as fontes utilizadas na pesquisa.",
    oQueToca: "Conhecimento compartilhado",
    risco: "seguro",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "knowledge_save_page",
    category: "write",
    rotulo: "Salvar uma página da equipe",
    explicacao:
      "Cria ou atualiza uma página compartilhada, verificando a revisão para preservar edições recentes.",
    oQueToca: "Conhecimento compartilhado",
    risco: "atencao",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
]);
