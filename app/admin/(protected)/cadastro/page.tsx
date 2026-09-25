import { notFound } from "next/navigation";

import { loadAuthUser } from "@/lib/auth/server";
import { modoDeCadastro } from "@/lib/auth/politica-de-cadastro";
import { listPendingRegistrationRequests } from "@/lib/auth/registration-requests";
import { traduzir } from "@/lib/i18n/dicionario";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { FormularioDeCadastro } from "./_form";
import { PedidosPendentes } from "./_pedidos";

export const metadata = { title: "Cadastro na instalação" };
export const dynamic = "force-dynamic";

/**
 * A tela onde o dono da instalação decide se aceita cadastro aberto.
 *
 * ── O defeito que ela fecha ─────────────────────────────────────────────────
 *
 * `/signup` sempre foi aberto e não havia como fechá-lo pelo produto. Quem
 * hospeda a própria instalação e vende tenant precisava bloquear a rota no
 * proxy reverso — fora do produto, e sem saber o que é um convite. Medido numa
 * instalação real em 2026-09-10: a regra de nginx que fazia isso barrava junto
 * o `/signup?invite=…`, exatamente quem deveria passar.
 *
 * ── Por que `/admin`, e não `/app/settings` ─────────────────────────────────
 *
 * O objeto é a INSTALAÇÃO. Num revendedor que hospeda várias empresas, deixar o
 * admin de um tenant fechar o cadastro impediria QUALQUER outra empresa de
 * entrar. Mesmo argumento de `/admin/marca` e `/admin/google`, e esta tela é
 * irmã das duas.
 *
 * ── Por que `notFound()`, e não `redirect('/403')` ──────────────────────────
 *
 * Para quem não administra a instalação, esta tela não faz parte do produto. O
 * layout de `(protected)` já roda `requirePlatformAdmin()`, então o gate abaixo
 * é redundante HOJE; ele fica porque a garantia precisa ser local, e um layout
 * pode ser movido. Mesma decisão, mesma frase, de `/admin/google`.
 */
export default async function Page() {
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();
  const admin = await requirePlatformAdmin();

  // A fila só é lida com a chave ligada: desligada, esta tela é a de antes.
  const modo = await modoDeCadastro();
  const pedidos = modo === "com_aprovacao" ? await listPendingRegistrationRequests() : null;
  const { rows: interessados } = admin.platformAdmin.scope === "full" ? await getRequestPool().query<{
    id: string;
    name: string;
    email: string;
    company: string;
    created_at: Date;
  }>(
    "select id,name,email,company,created_at from sales_waitlist where invited_at is null order by created_at desc limit 100",
  ) : { rows: [] };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {traduzir("Cadastro", usuario.idioma)}
        </h1>
        <p className="text-sm text-muted-foreground">
          {traduzir("Quem pode criar uma conta nesta instalação.", usuario.idioma)}
        </p>
      </div>
      <FormularioDeCadastro modoInicial={modo} />
      {admin.platformAdmin.scope === "full" && <Card>
        <CardHeader>
          <CardTitle>Lista de espera</CardTitle>
          <CardDescription>Interessados em receber um convite. O cadastro geral continua fechado.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {interessados.length === 0 && <p className="text-sm text-muted-foreground">Nenhum interessado aguardando.</p>}
          {interessados.map((pessoa) => (
            <div key={pessoa.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
              <div className="min-w-0">
                <p className="font-medium">{pessoa.company || pessoa.name}</p>
                <p className="text-sm text-muted-foreground">{pessoa.name} · {pessoa.email}</p>
              </div>
              <Link className="text-sm font-medium text-primary underline underline-offset-4" href={`/admin/tenants/new?email=${encodeURIComponent(pessoa.email)}&company=${encodeURIComponent(pessoa.company || pessoa.name)}`}>
                Criar empresa e convidar
              </Link>
            </div>
          ))}
        </CardContent>
      </Card>}
      {pedidos && <PedidosPendentes pedidos={pedidos} />}
    </div>
  );
}
