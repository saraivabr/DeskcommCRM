import { NewTenantForm } from "./_form";

export const metadata = { title: "Novo Tenant — Admin Plataforma" };

export default async function NewTenantPage({ searchParams }: { searchParams: Promise<{ email?: string | string[]; company?: string | string[] }> }) {
  const { email, company } = await searchParams;
  return <NewTenantForm
    initialOwnerEmail={(typeof email === "string" ? email : "").slice(0, 254)}
    initialCompany={(typeof company === "string" ? company : "").slice(0, 120)}
  />;
}
