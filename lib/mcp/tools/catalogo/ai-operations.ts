import { declararTools } from "./tipos";

export const TOOLS_AI_OPERATIONS = declararTools([
  {
    name: "ai_list_agents",
    category: "read",
    rotulo: "Listar agentes da empresa",
    explicacao: "Mostra os agentes, sua situação e qual versão está atendendo os clientes agora.",
    oQueToca: "Agentes de IA",
    risco: "seguro",
    pacotes: ["organizar"],
    apenasHumano: true,
  },
  {
    name: "ai_get_agent_configuration",
    category: "read",
    rotulo: "Ler configuração de um agente",
    explicacao: "Mostra as instruções e capacidades da versão publicada e dos rascunhos do agente.",
    oQueToca: "Agentes de IA",
    risco: "seguro",
    pacotes: ["organizar"],
    apenasHumano: true,
  },
  {
    name: "ai_create_agent_draft",
    category: "write",
    rotulo: "Preparar nova versão de um agente",
    explicacao:
      "Salva novas instruções em rascunho para revisão, sem mudar o atendimento em curso.",
    oQueToca: "Agentes de IA",
    risco: "atencao",
    pacotes: ["organizar"],
    apenasHumano: true,
  },
  {
    name: "ai_publish_agent_draft",
    category: "write",
    rotulo: "Publicar versão de um agente",
    explicacao: "Pede sua confirmação e coloca a versão revisada para atender clientes de verdade.",
    oQueToca: "Agentes de IA",
    risco: "critico",
    pacotes: ["organizar"],
    apenasHumano: true,
  },
]);
