export const carouselTemplates = {
  noticia_impacto_operacional: {
    label: "Da notícia ao impacto no negócio",
    description: "Uma novidade de IA, seus usos reais e o que muda na operação da empresa.",
    source: "https://www.instagram.com/p/DduXwDIiUvG/",
    slides: [
      {
        role: "Gancho",
        direction:
          "Abra com ator + ação inesperada + tarefa cotidiana. Foto editorial forte, título curto e grande.",
      },
      {
        role: "O anúncio",
        direction:
          "Explique quem anunciou, quando, o que foi anunciado e o estágio atual. Produto ou interface no topo; texto claro embaixo.",
      },
      {
        role: "O que resolve",
        direction:
          "Mostre de três a quatro usos concretos. Cena de uso no topo e lista curta abaixo.",
      },
      {
        role: "O detalhe",
        direction:
          "Mostre como funciona uma interação e os limites relevantes. Composição dividida entre explicação e cena/interface.",
      },
      {
        role: "Contexto",
        direction:
          "Explique antecedente e disponibilidade atual sem tratar teste como lançamento geral. Diagrama ou evidência contextual e texto legível.",
      },
      {
        role: "O outro lado",
        direction:
          "Vire a perspectiva para a empresa que recebe a demanda. Mostre a falha operacional possível como hipótese, sem inventar perdas.",
      },
      {
        role: "O que fazer",
        direction:
          "Entregue de três a cinco ações operacionais aplicáveis hoje. Sistema visual simples e bullets claros.",
      },
      {
        role: "Próximo passo",
        direction:
          "Conecte a oferta da empresa ao problema apresentado e faça um único convite claro. Identidade da empresa em destaque.",
      },
    ],
  },
} as const;

export type CarouselTemplateId = keyof typeof carouselTemplates;

export function carouselSlideBrief(idea: string, template: CarouselTemplateId, slide: number) {
  const selected = carouselTemplates[template];
  const step = selected.slides[slide - 1];
  if (!step) throw new Error("Slide inválido.");
  return `Carrossel original de 8 slides, formato vertical 4:5. Sistema visual constante: tipografia forte, alto contraste, acentos da marca da empresa, margens amplas e área segura para leitura no celular. Ideia e fatos fornecidos pelo usuário: ${idea}\nSlide ${slide}/8 — ${step.role}: ${step.direction}\nUse apenas fatos presentes na ideia; não invente datas, números, disponibilidade, fonte, resultados ou funcionalidades. Se a ideia não trouxer dados suficientes para uma afirmação, escreva de forma condicional. Interfaces sem captura comprovada devem parecer ilustrações conceituais, nunca prova real. Cada slide deve avançar a narrativa sem repetir o anterior. Não copie frases, fotos, pessoas ou marcas de outro perfil.`;
}
