import type { Metadata } from "next";
import Link from "next/link";

import { getMetaDeletionStatus } from "@/lib/channels/meta/social/removal";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const idioma = await idiomaDoVisitante(null);
  return {
    title: traduzir("Acompanhamento da exclusão Meta", idioma),
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

export default async function MetaDataDeletionStatusPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const [idioma, query] = await Promise.all([idiomaDoVisitante(null), searchParams]);
  const t = (texto: string) => traduzir(texto, idioma);
  const code =
    typeof query.code === "string" && /^[0-9a-f]{64}$/.test(query.code) ? query.code : null;
  let status: Awaited<ReturnType<typeof getMetaDeletionStatus>> = null;
  let unavailable = false;
  if (code) {
    try {
      status = await getMetaDeletionStatus(code);
    } catch {
      unavailable = true;
    }
  }

  return (
    <>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("Acompanhamento da exclusão Meta")}
        </h1>
      </header>
      <section className="space-y-2" aria-live="polite">
        {unavailable ? (
          <>
            <h2 className="text-base font-semibold">
              {t("Consulta temporariamente indisponível")}
            </h2>
            <p>
              {t(
                "Não foi possível consultar o pedido agora. Atualize esta página em instantes; a falha de consulta não confirma a conclusão da exclusão.",
              )}
            </p>
          </>
        ) : status === "completed" ? (
          <>
            <h2 className="text-base font-semibold">{t("Exclusão concluída")}</h2>
            <p>{t("A remoção dos dados locais da autorização Meta solicitada foi concluída.")}</p>
            <p>
              {t(
                "Permanecem o comprovante mínimo do pedido e os marcadores de segurança descritos nas instruções de exclusão.",
              )}
            </p>
          </>
        ) : status === "pending" || status === "processing" ? (
          <>
            <h2 className="text-base font-semibold">{t("Exclusão em processamento")}</h2>
            <p>
              {t(
                "Seu pedido foi recebido e a remoção dos dados está em andamento. Atualize esta página para consultar o resultado.",
              )}
            </p>
          </>
        ) : (
          <>
            <h2 className="text-base font-semibold">{t("Pedido não encontrado")}</h2>
            <p>
              {t(
                "Abra o link completo fornecido na confirmação da solicitação. Se o pedido continuar indisponível, consulte as instruções de exclusão e o contato responsável.",
              )}
            </p>
          </>
        )}
      </section>
      <Link
        className="inline-block underline underline-offset-2"
        href="/legal/meta-data-deletion"
        prefetch={false}
      >
        {t("Instruções de exclusão e contato")}
      </Link>
    </>
  );
}
