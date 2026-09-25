import { authorizeInput, mcpResource } from "@/lib/mcp/oauth";
import { createAdminClient } from "@/lib/supabase/admin";
export const dynamic = "force-dynamic";
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parsed = authorizeInput.safeParse(await searchParams);
  if (!parsed.success || parsed.data.resource !== mcpResource())
    return <main className="p-8">Solicitação de conexão inválida.</main>;
  const params = parsed.data;
  const { data: client, error } = await createAdminClient()
    .from("mcp_oauth_clients")
    .select("name,redirect_uris")
    .eq("id", params.client_id)
    .maybeSingle();
  if (
    error ||
    !client ||
    !Array.isArray(client.redirect_uris) ||
    !client.redirect_uris.includes(params.redirect_uri)
  )
    return <main className="p-8">Cliente ou endereço de retorno inválido.</main>;
  // First-party navigation restores SameSite=Strict session cookies. This public page grants nothing.
  const query = new URLSearchParams(params);
  return (
    <main className="mx-auto max-w-lg space-y-5 p-8">
      <h1 className="text-2xl font-semibold">Conectar {client.name} ao escreve.ai</h1>
      <p>Entre na sua conta para escolher a organização e revisar as permissões solicitadas.</p>
      <a className="underline" href={`/app/settings/ai-connections?${query}`}>
        Continuar para revisar acesso
      </a>
    </main>
  );
}
