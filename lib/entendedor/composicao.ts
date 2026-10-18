/**
 * A nota que o entendedor manda no WhatsApp. Puro e determinístico.
 *
 * Formato herdado do fluxo que já estava no ar (versão de 17/10/2026), com dois
 * consertos: a duração tem plural certo ("1 minuto e 1 segundo") e o bloco do
 * texto literal não se chama mais "Transcrição" — o produto entende áudio, e a
 * fala literal é só um apoio para conferir.
 */
import type { Entendimento } from "@/lib/entendedor/prompt";

/**
 * O WhatsApp recolhe atrás do "Ler mais" o que vem depois de um bloco longo de
 * caracteres invisíveis. Com isto a pessoa vê só o cabeçalho e toca para abrir.
 * Word Joiner (U+2060), 7002 vezes — o valor que o fluxo anterior validou.
 */
export const RECOLHER_NO_LER_MAIS = "⁠".repeat(7002);

const MAX_ENTENDIMENTO = 520;
const MAX_NOME = 60;

/** Tira quebra de linha e marcação do WhatsApp do texto do modelo. */
export function limparTextoDoModelo(valor: unknown, max = MAX_ENTENDIMENTO): string {
  return String(valor ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function duracaoPorExtenso(segundos: number): string {
  const s = Math.max(0, Math.round(segundos));
  const seg = (n: number) => `${n} ${n === 1 ? "segundo" : "segundos"}`;
  if (s < 60) return seg(s);
  const minutos = Math.floor(s / 60);
  const resto = s % 60;
  const min = `${minutos} ${minutos === 1 ? "minuto" : "minutos"}`;
  return resto ? `${min} e ${seg(resto)}` : min;
}

const COMECO_GENERICO = /^(?:o autor|o remetente|o emissor|o interlocutor|a pessoa|o usuário)\b/i;

export interface NotaDoEntendedor {
  segundos: number;
  /** Quem falou, como a pessoa que lê reconhece: o nome salvo do contato, ou "Você". */
  quemFalou: string;
  entendimento: Entendimento | null;
  textoFalado: string;
  mostrarEntendimento: boolean;
  mostrarTextoFalado: boolean;
  /** Nome da marca, resolvido por `marcaDaSaida` — nunca escrito no código. */
  marca: string;
}

/**
 * Monta a nota. Devolve `null` quando não há o que mandar (o entendimento foi
 * pedido e veio vazio, e o texto falado está desligado): mandar só o
 * cabeçalho seria uma mensagem vazia na conversa de alguém.
 */
export function comporNota(nota: NotaDoEntendedor): string | null {
  const itens: string[] = [];
  const quem = limparTextoDoModelo(nota.quemFalou, MAX_NOME) || "Contato";

  if (nota.mostrarEntendimento) {
    const e = nota.entendimento;
    let corpo = limparTextoDoModelo(e?.message);
    if (COMECO_GENERICO.test(corpo)) corpo = limparTextoDoModelo(e?.key_sentence);
    if (corpo.toLowerCase().startsWith(`${quem.toLowerCase()} `)) corpo = corpo.slice(quem.length).trim();
    if (corpo) itens.push(`${e?.category === "simple" ? "💬" : "🎯"} *${quem}:* ${corpo}`);
  }

  const falado = nota.textoFalado.trim();
  if (nota.mostrarTextoFalado && falado) itens.push(`📄 *O que foi dito*\n${falado}`);

  if (itens.length === 0) return null;

  const cabecalho =
    nota.segundos > 0
      ? `🤖 *economizei ${duracaoPorExtenso(nota.segundos)} do seu tempo* 👇`
      : "🤖 *entendi esse áudio por você* 👇";
  const assinatura = `_explicado por *${limparTextoDoModelo(nota.marca, MAX_NOME) || "seu assistente"}*_`;

  return `${cabecalho}\n${RECOLHER_NO_LER_MAIS}\n\n${itens.join("\n\n")}\n\n${assinatura}`;
}
