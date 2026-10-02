"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import type { StandardSellerProfile } from "@/lib/prospecting/schema";

export type SellerProfile = StandardSellerProfile;

export function ProspectingSellerProfile({
  seller,
  busy,
  onSave,
}: {
  seller: SellerProfile;
  busy: boolean;
  onSave: (profile: SellerProfile) => Promise<boolean>;
}) {
  const t = useT();
  // A background refresh must not replace text the operator is still editing.
  const [draft, setDraft] = useState<SellerProfile | null>(null);
  const profile = draft ?? seller;
  const update = (field: keyof SellerProfile, value: string) =>
    setDraft((current) => ({ ...(current ?? seller), [field]: value }));
  return (
    <Card className="p-5">
      <h2 className="text-lg font-semibold">{t("Apresentação e oferta")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t(
          "Configure uma vez quem fala, qual empresa representa e o que vende. Nas próximas buscas, você só muda o segmento.",
        )}
      </p>
      <form
        className="mt-4 grid gap-4 sm:grid-cols-2"
        onSubmit={async (event) => {
          event.preventDefault();
          if (await onSave(profile)) setDraft(null);
        }}
      >
        <div>
          <Label htmlFor="prospecting-seller-name">{t("Nome da vendedora")}</Label>
          <Input
            id="prospecting-seller-name"
            className="mt-1"
            value={profile.seller_name}
            disabled={busy}
            onChange={(event) => update("seller_name", event.target.value)}
            required
            minLength={2}
            maxLength={120}
          />
        </div>
        <div>
          <Label htmlFor="prospecting-company-name">{t("Empresa que representa")}</Label>
          <Input
            id="prospecting-company-name"
            className="mt-1"
            value={profile.company_name}
            disabled={busy}
            onChange={(event) => update("company_name", event.target.value)}
            required
            minLength={2}
            maxLength={160}
          />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="prospecting-seller-offer">
            {t("Como sua empresa ajuda os clientes")}
          </Label>
          <Textarea
            id="prospecting-seller-offer"
            className="mt-1"
            value={profile.offer}
            disabled={busy}
            onChange={(event) => update("offer", event.target.value)}
            required
            minLength={10}
            maxLength={2000}
            placeholder={t("Descreva o que você vende e o benefício que pode demonstrar.")}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            {t(
              "A conversa adapta a linguagem e os exemplos ao segmento, sem inventar produtos, resultados ou condições.",
            )}
          </p>
        </div>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={busy}>
            {t("Salvar apresentação e oferta")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
