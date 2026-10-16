/**
 * Preserva metadados do gatilho que a tela não edita. Trocar o evento descarta
 * a configuração antiga: uma chave pode ter significado diferente no outro.
 * Port seletivo da v1.82.0 para o designer; não acrescenta gatilhos ao motor.
 */
export function configAoSalvarDaTela(entrada: {
  /** O `trigger_event` da regra carregada. Vazio/null em regra nova. */
  gatilhoDaRegra: string | null | undefined;
  /** O `trigger_config` cru da regra carregada, como veio do banco. */
  configDaRegra: unknown;
  /** O gatilho escolhido na tela agora. */
  gatilhoDaTela: string;
  /** O que a tela edita, com os valores atuais do formulário. */
  configDaTela: Record<string, unknown>;
}): Record<string, unknown> {
  const mesmoGatilho = !!entrada.gatilhoDaRegra && entrada.gatilhoDaRegra === entrada.gatilhoDaTela;
  const guardada = mesmoGatilho ? entrada.configDaRegra : null;
  // Configuração torta (string, lista, `null`) não derruba o salvar: a tela
  // grava o que ela conhece, e o defeito de origem segue visível na leitura.
  const base =
    guardada && typeof guardada === "object" && !Array.isArray(guardada)
      ? (guardada as Record<string, unknown>)
      : {};
  return { ...base, ...entrada.configDaTela };
}
