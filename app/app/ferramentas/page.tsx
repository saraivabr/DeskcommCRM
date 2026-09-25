import type { Metadata } from "next";
import { requireAuth } from "@/lib/auth/server";
import { ToolsCatalog } from "./ToolsCatalog";

export const metadata: Metadata = { title: "Todas as ferramentas" };

export default async function FerramentasPage() {
  await requireAuth();
  return <ToolsCatalog />;
}
