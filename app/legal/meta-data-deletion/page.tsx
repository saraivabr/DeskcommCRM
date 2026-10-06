import type { Metadata } from "next";
import Link from "next/link";

import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { traduzir } from "@/lib/i18n/dicionario";
import { resolverOperador } from "@/lib/legal/operador";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const idioma = await idiomaDoVisitante(null);
  return {
    title: traduzir("Excluir dados da conexão Meta", idioma),
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

export default async function MetaDataDeletionPage() {
  const [idioma, operador] = await Promise.all([idiomaDoVisitante(null), resolverOperador()]);
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("Excluir dados da conexão Meta")}
        </h1>
        <p className="text-muted-foreground">
          {t(
            "Como solicitar a remoção dos dados recebidos do Facebook e do Instagram nesta instalação.",
          )}
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("Como solicitar")}</h2>
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            {t(
              "No Facebook, abra as configurações de aplicativos e sites e localize o aplicativo usado nesta conexão.",
            )}
          </li>
          <li>
            {t(
              "Ao remover o aplicativo, solicite também a exclusão de dados, quando essa opção for oferecida.",
            )}
          </li>
          <li>
            {t(
              "Guarde o código de confirmação e abra o link de acompanhamento fornecido para consultar o andamento da exclusão.",
            )}
          </li>
        </ol>
        <p>
          {t(
            "Desconectar em Conexões interrompe novas ações. Para remover também os dados locais dessa autorização, solicite a exclusão pelo Facebook.",
          )}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("O que é excluído")}</h2>
        <p>
          {t(
            "O pedido remove a identificação e os tokens dessa autorização, os registros locais de publicações e campanhas associados a ela e as cópias de imagens preparadas para publicação. O inventário de contas é removido quando não está vinculado a outra autorização independente.",
          )}
        </p>
        <p>
          {t(
            "Novas ações ficam bloqueadas enquanto o pedido é processado. Uma ação já enviada à Meta pode concluir antes da revogação; confira o resultado na própria Meta.",
          )}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("O que permanece")}</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            {t(
              "O comprovante mínimo do pedido e marcadores de segurança que impedem o retorno de dados excluídos.",
            )}
          </li>
          <li>{t("Os arquivos originais do Studio e os dados de atendimento do CRM.")}</li>
          <li>{t("As conexões sociais já existentes e as outras autorizações independentes.")}</li>
          <li>
            {t(
              "As publicações e os anúncios que já existem no Facebook ou no Instagram. Para removê-los ou alterar a veiculação, use a própria Meta.",
            )}
          </li>
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("Ajuda com a solicitação")}</h2>
        <p>
          {operador.dpoEmail ? (
            <>
              {t(
                "Para pedir ajuda com a exclusão, fale com o encarregado de dados desta instalação:",
              )}{" "}
              <a
                className="break-all underline underline-offset-2"
                href={`mailto:${operador.dpoEmail}`}
              >
                {operador.dpoEmail}
              </a>
              .
            </>
          ) : (
            t(
              "Se não conseguir solicitar a exclusão pelo Facebook, entre em contato com quem opera esta instalação pelos canais de atendimento que você já utiliza.",
            )
          )}
        </p>
      </section>

      <Link className="inline-block underline underline-offset-2" href="/legal/privacy">
        {t("Política de Privacidade")}
      </Link>
    </>
  );
}
