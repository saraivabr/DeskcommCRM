/**
 * Quais áudios o entendedor processa. Puro: recebe a configuração e a mensagem,
 * devolve a decisão com o motivo — o motivo vai para o log do handler, porque
 * "por que este áudio não foi entendido?" é a primeira pergunta do suporte.
 */

export interface ConfiguracaoDoEntendedor {
  enabled: boolean;
  process_received: boolean;
  process_sent: boolean;
  groups_enabled: boolean;
  show_understanding: boolean;
  show_spoken_text: boolean;
  monthly_limit_seconds: number | null;
}

/** Valores de quem nunca salvou: desligado, e o resto igual ao padrão do banco. */
export const CONFIGURACAO_PADRAO: ConfiguracaoDoEntendedor = {
  enabled: false,
  process_received: true,
  process_sent: false,
  groups_enabled: false,
  show_understanding: true,
  show_spoken_text: true,
  monthly_limit_seconds: null,
};

export interface AudioCandidato {
  direction: "inbound" | "outbound";
  isGroup: boolean;
}

export type DecisaoDoEntendedor =
  | { processa: true }
  | {
      processa: false;
      motivo: "desligado" | "direcao_desligada" | "grupo_desligado" | "nenhuma_saida";
    };

export function decidirSeEntende(
  config: ConfiguracaoDoEntendedor,
  audio: AudioCandidato,
): DecisaoDoEntendedor {
  if (!config.enabled) return { processa: false, motivo: "desligado" };
  if (!config.show_understanding && !config.show_spoken_text) {
    return { processa: false, motivo: "nenhuma_saida" };
  }
  if (audio.isGroup && !config.groups_enabled) return { processa: false, motivo: "grupo_desligado" };
  const direcaoLigada = audio.direction === "outbound" ? config.process_sent : config.process_received;
  if (!direcaoLigada) return { processa: false, motivo: "direcao_desligada" };
  return { processa: true };
}
