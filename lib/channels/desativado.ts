/** Leitura estrita do estado salvo; ausente/nulo mantém o canal elegível. */
export function canalDesativado(metadata: unknown): boolean {
  if (metadata === null || typeof metadata !== "object") return false;
  return (metadata as Record<string, unknown>).disabled === true;
}
