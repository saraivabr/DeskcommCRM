/**
 * SEM SMTP, O "ESQUECI A SENHA" DIZ O MOTIVO — E COM SMTP, O GENÉRICO FICA.
 *
 * ─── O defeito (#2755) ─────────────────────────────────────────────────────
 *
 * A instalação SEM SMTP faz o GoTrue falhar no `resetPasswordForEmail`, e a
 * action devolvia `{ ok: false, error: "request_failed" }` — o mesmo código de
 * QUALQUER outra falha de infra. A tela traduzia: "Não foi possível enviar o
 * e-mail. Tente novamente." Quem esqueceu a senha tentava de novo, e de novo,
 * e de novo: o gesto nunca funcionaria, porque o problema não é a tentativa, é
 * que AQUELA instalação não envia e-mail nenhum. O motivo nem era segredo — o
 * kit já escreve no log ("Sem SMTP no CRM: ..."), só que em outro lugar, onde
 * quem está na tela não vai ler.
 *
 * ─── O que se guarda ───────────────────────────────────────────────────────
 *
 * O PAR é o que prende o comportamento. Só o caso "sem SMTP" passaria com um
 * `if` que devolvesse `smtp_not_configured` sempre, trocando um erro anônimo
 * por outro mentiroso (instalação com SMTP que caiu por outra causa diria que
 * falta SMTP). Daí o caso de controle: com SMTP configurado e o GoTrue falhando
 * por motivo qualquer, o código continua sendo o genérico de antes.
 *
 * Os limites da régua, um a um, porque os três são fáceis de errar:
 *
 *   - host SEM remetente não é SMTP usável — é a mesma régua de
 *     `sincronizar_smtp_do_gotrue` (`_common.sh`), que recusa com rc=1;
 *   - o 429 da catraca continua vencendo: quem bateu no teto ouve a catraca,
 *     não a conversa sobre SMTP;
 *   - a consulta de estado que FALHA não vira "sem SMTP": não se afirma o que
 *     não se mediu, e o desfecho de um motivo desconhecido é o erro genérico
 *     de sempre (que é honesto: de fato não sabemos por que falhou).
 *
 * Confira com: pnpm vitest run tests/unit/esqueci-a-senha-sem-smtp-diz-o-motivo.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type RespostaGoTrue = { error: { message: string; status?: number } | null };
type Smtp = {
  host: string;
  port: number;
  security: "starttls" | "tls" | "none";
  username: string;
  password: string;
  fromEmail: string;
  fromName: string;
  source: "database" | "environment" | "none";
};

const SEM_SMTP: Smtp = {
  host: "",
  port: 587,
  security: "starttls",
  username: "",
  password: "",
  fromEmail: "",
  fromName: "",
  source: "none",
};

const COM_SMTP: Smtp = {
  ...SEM_SMTP,
  host: "smtp.revenda.com.br",
  username: "nao-responda@revenda.com.br",
  password: "segredo",
  fromEmail: "nao-responda@revenda.com.br",
  fromName: "Revenda",
  source: "database",
};

const estado = {
  smtp: SEM_SMTP as Smtp,
  smtpResponde: true as boolean,
  resposta: { error: null } as RespostaGoTrue,
  chamouGoTrue: 0,
};

vi.mock("next/headers", () => ({ headers: async () => ({ get: () => null }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      resetPasswordForEmail: async () => {
        estado.chamouGoTrue += 1;
        return estado.resposta;
      },
    },
  }),
}));
vi.mock("@/lib/audit", () => ({
  audit: async () => {},
  hashEmail: (email: string) => `hash:${email}`,
}));
vi.mock("@/lib/auth/rate-limit", () => ({
  authRateLimited: async () => false,
  AUTH_LIMITS: { reset: { ip: 30, id: 3, windowSec: 3600 } },
}));
vi.mock("@/lib/email/config", () => ({
  getSmtpConfig: async () => {
    if (!estado.smtpResponde) throw new Error("banco fora do ar");
    return estado.smtp;
  },
}));

const { requestPasswordReset } = await import("@/app/actions/auth/requestPasswordReset");

const EMAIL = "dono@revenda.test";
const falhaDoGoTrue = (status?: number) => ({
  error: { message: "Error sending recovery email", status },
});

beforeEach(() => {
  estado.smtp = SEM_SMTP;
  estado.smtpResponde = true;
  estado.resposta = { error: null };
  estado.chamouGoTrue = 0;
});

describe("esqueci a senha numa instalação SEM SMTP", () => {
  it("⭐ o erro do GoTrue vira smtp_not_configured — não o genérico", async () => {
    estado.resposta = falhaDoGoTrue(500);

    const r = await requestPasswordReset({ email: EMAIL });

    expect(r).toEqual({ ok: false, error: "smtp_not_configured" });
  });

  it("host SEM remetente não conta como SMTP (mesma régua do kit)", async () => {
    estado.smtp = { ...COM_SMTP, fromEmail: "" };
    estado.resposta = falhaDoGoTrue(500);

    const r = await requestPasswordReset({ email: EMAIL });

    expect(r).toEqual({ ok: false, error: "smtp_not_configured" });
  });

  it("a catraca (429) continua vencendo a mensagem nova", async () => {
    estado.resposta = falhaDoGoTrue(429);

    const r = await requestPasswordReset({ email: EMAIL });

    expect(r).toEqual({ ok: false, error: "rate_limited" });
  });

  it("a consulta de SMTP que falha NÃO vira 'sem SMTP' — cai no genérico", async () => {
    estado.smtpResponde = false;
    estado.resposta = falhaDoGoTrue(500);

    const r = await requestPasswordReset({ email: EMAIL });

    expect(r).toEqual({ ok: false, error: "request_failed" });
  });
});

describe("esqueci a senha numa instalação COM SMTP", () => {
  it("⭐ CONTROLE — o genérico preservado: falha por outro motivo", async () => {
    estado.smtp = COM_SMTP;
    estado.resposta = falhaDoGoTrue(500);

    const r = await requestPasswordReset({ email: EMAIL });

    expect(r).toEqual({ ok: false, error: "request_failed" });
  });

  it("o caminho de sucesso continua como estava", async () => {
    estado.smtp = COM_SMTP;
    estado.resposta = { error: null };

    const r = await requestPasswordReset({ email: EMAIL });

    expect(r).toEqual({ ok: true });
    expect(estado.chamouGoTrue).toBe(1);
  });
});
