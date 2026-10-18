/**
 * Franquia do entendedor de áudio — quanto cada organização pode usar por mês.
 *
 * Puro de propósito: o período e o limite são decididos aqui e passados à
 * reserva no banco (`fn_entendedor_reservar`), que só soma e trava. Dois
 * lugares calculando "que mês é" divergiriam na virada do mês em UTC.
 */

/** 30 minutos por mês, grátis — a porta de entrada do produto. */
export const FRANQUIA_GRATIS_SEGUNDOS = 30 * 60;

/** O mês civil de São Paulo, não o de UTC: às 22h do dia 31 ainda é o mesmo mês para o cliente. */
const FUSO_DO_PERIODO = "America/Sao_Paulo";

/** Primeiro dia do mês em vigor, como `YYYY-MM-01`. */
export function inicioDoPeriodo(agora: Date = new Date()): string {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: FUSO_DO_PERIODO,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(agora);
  const ano = partes.find((p) => p.type === "year")?.value ?? String(agora.getUTCFullYear());
  const mes = partes.find((p) => p.type === "month")?.value ?? "01";
  return `${ano}-${mes}-01`;
}

/** Primeiro dia do mês seguinte — quando a franquia renova. */
export function inicioDoProximoPeriodo(agora: Date = new Date()): string {
  const [ano, mes] = inicioDoPeriodo(agora).split("-").map(Number) as [number, number];
  const proximoAno = mes === 12 ? ano + 1 : ano;
  const proximoMes = mes === 12 ? 1 : mes + 1;
  return `${proximoAno}-${String(proximoMes).padStart(2, "0")}-01`;
}

/**
 * O limite que vale para a organização. `null` na configuração = o padrão da
 * instalação. Valor inválido também cai no padrão — nunca em "ilimitado".
 */
export function limiteDaOrganizacao(monthlyLimitSeconds: number | null | undefined): number {
  if (typeof monthlyLimitSeconds === "number" && Number.isInteger(monthlyLimitSeconds) && monthlyLimitSeconds >= 0) {
    return monthlyLimitSeconds;
  }
  return FRANQUIA_GRATIS_SEGUNDOS;
}

/**
 * A duração que conta para a franquia: inteiro, arredondado para cima. Um áudio
 * de 0,4 s ainda é um áudio, e arredondar para baixo daria 0, que a reserva
 * recusa.
 */
export function segundosCobraveis(duracao: number | null | undefined): number | null {
  if (typeof duracao !== "number" || !Number.isFinite(duracao) || duracao <= 0) return null;
  return Math.ceil(duracao);
}
