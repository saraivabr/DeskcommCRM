"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  updateMetaNativeConfiguration,
  type MetaNativeConfigurationInput,
} from "@/app/actions/settings/updateMetaApp";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";

export type MetaNativeSettings = Omit<MetaNativeConfigurationInput, "app_secret">;

export function MetaNativeConfigurationForm({
  initial,
  readFailed,
}: {
  initial: MetaNativeSettings;
  readFailed: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const valid =
    /^\d{5,30}$/.test(values.app_id) &&
    /^\d{5,30}$/.test(values.config_id) &&
    (!secret || secret.trim().length >= 16);

  function save() {
    setError(null);
    start(async () => {
      try {
        const result = await updateMetaNativeConfiguration({
          ...values,
          ...(secret.trim() ? { app_secret: secret.trim() } : {}),
        });
        if (!result.ok) {
          if (result.error === "mfa_required") {
            router.push("/login/mfa?next=/admin/meta");
            return;
          }
          setError(
            result.error === "meta_app_config_changed"
              ? t("A configuração mudou em outra sessão. Recarregue a página antes de salvar.")
              : result.error === "meta_app_identity_requires_secret" ||
                  result.error === "meta_app_config_incomplete"
                ? t(
                    "Informe a chave secreta correspondente ao App ID para configurar este aplicativo.",
                  )
                : t("Não foi possível salvar a configuração. Confira os IDs e tente novamente."),
          );
          return;
        }
        setValues((current) => ({ ...current, expected_revision: result.revision }));
        setSecret("");
        toast.success(t("Login empresarial configurado."));
        router.refresh();
      } catch {
        setError(t("Não foi possível salvar a configuração. Tente novamente."));
      }
    });
  }

  return (
    <Card className="flex flex-col gap-4 p-4" data-testid="meta-native-settings">
      <div>
        <h2 className="font-medium">{t("Login empresarial para Instagram e anúncios")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "Use a configuração do Facebook Login for Business do aplicativo desta instalação. Cada empresa autoriza e seleciona suas próprias contas em Conexões.",
          )}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="meta-native-app-id">{t("App ID")}</Label>
        <Input
          id="meta-native-app-id"
          disabled={pending || readFailed}
          inputMode="numeric"
          value={values.app_id}
          onChange={(event) => setValues({ ...values, app_id: event.target.value.trim() })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="meta-native-config-id">
          {t("ID da configuração do login empresarial")}
        </Label>
        <Input
          id="meta-native-config-id"
          disabled={pending || readFailed}
          inputMode="numeric"
          value={values.config_id}
          onChange={(event) => setValues({ ...values, config_id: event.target.value.trim() })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="meta-native-secret">{t("Chave secreta correspondente ao App ID")}</Label>
        <Input
          id="meta-native-secret"
          disabled={pending || readFailed}
          type="password"
          autoComplete="off"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {t(
            "Deixe em branco para manter a chave salva. Ao trocar o App ID, informe a chave do novo aplicativo. A chave também é usada pelo canal oficial da Meta.",
          )}
        </p>
      </div>
      {(
        [
          ["native_enabled", t("Habilitar conexão com a Meta")],
          ["instagram_enabled", t("Habilitar publicação no Instagram")],
          ["ads_enabled", t("Habilitar anúncios Meta")],
        ] as const
      ).map(([field, label]) => (
        <Label key={field} className="flex items-center gap-2">
          <input
            type="checkbox"
            disabled={pending || readFailed}
            checked={values[field]}
            onChange={(event) => setValues({ ...values, [field]: event.target.checked })}
          />
          {label}
        </Label>
      ))}
      <p className="text-xs text-muted-foreground">
        {t(
          "As funcionalidades dependem também das permissões aprovadas pela Meta e dos acessos concedidos em cada conta.",
        )}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button onClick={save} disabled={!valid || pending || readFailed}>
        {pending ? t("Salvando…") : t("Salvar login empresarial")}
      </Button>
    </Card>
  );
}
