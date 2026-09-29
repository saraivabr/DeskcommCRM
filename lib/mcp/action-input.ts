import { z } from "zod";
import type { McpContext } from "./types";

export const personalOperationShape = {
  operation_id: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Conexões pessoais exigem UUID estável por operação. Reutilize nas retentativas; uma intenção nova exige outro UUID.",
    ),
};

/** Legacy agents keep their wire contract; personal confirmations identify each deliberate action. */
export async function requirePersonalOperation(
  input: { operation_id?: string },
  ctx: McpContext,
): Promise<void> {
  if (ctx.connectionId && !z.string().uuid().safeParse(input.operation_id).success)
    throw new Error(
      "Informe operation_id UUID estável. Reutilize a mesma chave e parâmetros nas retentativas.",
    );
}
