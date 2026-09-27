import { declararTools } from "./tipos";

export const TOOLS_CONTENT_OPERATIONS = declararTools([
  {
    name: "content_list_studio_posts",
    category: "read",
    rotulo: "Ver postagens do Estúdio",
    explicacao: "Mostra as postagens e rascunhos recentes com legenda, imagem e estado da criação.",
    oQueToca: "Conteúdo do Estúdio",
    risco: "seguro",
    pacotes: ["organizar"],
    apenasHumano: true,
  },
  {
    name: "content_generate_studio_post",
    category: "write",
    rotulo: "Gerar postagem para revisar",
    explicacao:
      "Pede sua confirmação, usa créditos de IA e salva imagem e legenda no Estúdio sem publicar.",
    oQueToca: "Conteúdo do Estúdio",
    risco: "critico",
    pacotes: ["organizar"],
    apenasHumano: true,
  },
]);
