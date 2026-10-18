import { z } from "zod";

/**
 * O que a tela do Entendedor pode mudar. O limite mensal NÃO está aqui de
 * propósito: a franquia é decisão de quem opera a instalação, não da própria
 * organização — senão a empresa se daria minutos grátis infinitos.
 */
export const entendedorPatchSchema = z
  .object({
    enabled: z.boolean(),
    process_received: z.boolean(),
    process_sent: z.boolean(),
    show_understanding: z.boolean(),
    show_spoken_text: z.boolean(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "nada para salvar" });

export type EntendedorPatch = z.infer<typeof entendedorPatchSchema>;
