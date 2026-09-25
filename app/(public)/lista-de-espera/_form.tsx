"use client";
import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";

export function WaitlistForm() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/v1/sales/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(data)),
      });
      if (!response.ok)
        throw new Error(
          response.status === 429
            ? "Aguarde um pouco antes de tentar novamente."
            : "Não foi possível enviar agora. Tente novamente em instantes.",
        );
      setDone(true);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Não foi possível enviar agora. Tente novamente em instantes.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("Entre na lista de espera")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Deixe seu contato para conversarmos sobre o acesso da sua empresa.")}
        </p>
      </div>
      {done ? (
        <p role="status">
          {t(
            "Pedido recebido. A equipe entrará em contato sobre os próximos passos. Este pedido não cria uma conta nem garante um convite.",
          )}
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="waitlist-name">{t("Seu nome")}</Label>
            <Input
              id="waitlist-name"
              name="name"
              required
              minLength={2}
              maxLength={120}
              autoComplete="name"
              disabled={busy}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="waitlist-email">{t("E-mail")}</Label>
            <Input
              id="waitlist-email"
              name="email"
              type="email"
              required
              maxLength={254}
              autoComplete="email"
              disabled={busy}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="waitlist-company">{t("Empresa (opcional)")}</Label>
            <Input
              id="waitlist-company"
              name="company"
              maxLength={160}
              autoComplete="organization"
              disabled={busy}
            />
          </div>
          <div aria-hidden="true" className="hidden">
            <label htmlFor="waitlist-website">{t("Site")}</label>
            <input id="waitlist-website" name="website" tabIndex={-1} autoComplete="off" />
          </div>
          <p className="text-xs text-muted-foreground">
            {t("Usaremos estes dados para responder ao seu interesse no acesso.")}
          </p>
          {error && <p role="alert">{t(error)}</p>}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? t("Enviando...") : t("Entrar na lista de espera")}
          </Button>
        </form>
      )}
      <Link href="/login" className="block text-sm underline">
        {t("Já tenho acesso")}
      </Link>
      <Link href="/" className="block text-sm underline">
        {t("Voltar ao início")}
      </Link>
    </div>
  );
}
