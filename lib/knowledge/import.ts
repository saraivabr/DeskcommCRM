import { lookup } from "node:dns/promises";
import { get } from "node:https";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { ipEhEspecial } from "@/lib/automation/outbound-ip";
import { KnowledgeError } from "./service";

export async function limitedBody(req: Request, max: number): Promise<Uint8Array> {
  const reader = req.body?.getReader();
  if (!reader) throw new KnowledgeError("empty_body", "Conteúdo vazio.", 422);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        throw new KnowledgeError("too_large", "Arquivo muito grande. Limite de 10 MB.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/** DNS is pinned to the checked IP for the TLS connection, including every redirect. */
export async function captureUrl(
  input: string,
  hops = 0,
): Promise<{ title: string; markdown: string; url: string }> {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    hops > 3
  )
    throw new KnowledgeError("unsafe_url", "Use um endereço HTTPS público, sem senha.", 422);
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => ipEhEspecial(a.address)))
    throw new KnowledgeError("unsafe_url", "Este endereço não pode ser importado.", 422);
  const target = addresses[0]!;
  const fetched = await new Promise<{ body: string; location?: string }>((resolve, reject) => {
    const request = get(
      url,
      {
        headers: { "User-Agent": "KnowledgeImporter/1.0", Accept: "text/html,text/plain" },
        lookup: (_host, opts, cb) => {
          if (opts.all) cb(null, [target]);
          else cb(null, target.address, target.family);
        },
      },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          resolve({ body: "", location: response.headers.location });
          return;
        }
        if (
          response.statusCode !== 200 ||
          !/text\/(html|plain)/i.test(response.headers["content-type"] ?? "")
        ) {
          response.resume();
          reject(
            new KnowledgeError(
              "import_failed",
              "O site não disponibilizou uma página de texto pública.",
              422,
            ),
          );
          return;
        }
        const buffers: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2_000_000)
            request.destroy(
              new KnowledgeError("too_large", "Página maior que o limite de importação.", 413),
            );
          else buffers.push(chunk);
        });
        response.on("end", () => resolve({ body: Buffer.concat(buffers).toString("utf8") }));
        response.on("error", reject);
      },
    );
    const timer = setTimeout(
      () => request.destroy(new Error("Tempo de captura excedido.")),
      15_000,
    );
    request.on("close", () => clearTimeout(timer));
    request.on("error", reject);
  });
  if (fetched.location) return captureUrl(new URL(fetched.location, url).href, hops + 1);
  const { document } = parseHTML(fetched.body);
  const article = new Readability(document as unknown as Document).parse();
  const text = article?.textContent?.trim() ?? "";
  if (!text)
    throw new KnowledgeError(
      "empty_document",
      "Não foi encontrado texto. Cole o conteúdo em uma página.",
      422,
    );
  if (text.length > 200_000)
    throw new KnowledgeError("too_large", "O texto excede o limite de 200 mil caracteres.", 413);
  return { title: (article?.title || url.hostname).slice(0, 120), markdown: text, url: url.href };
}
