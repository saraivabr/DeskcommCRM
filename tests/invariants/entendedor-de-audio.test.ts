/**
 * Entendedor de áudio no banco real (baseline aplicado): isolamento entre
 * organizações, escrita só de admin, consumo fora do alcance da REST e a
 * reserva atômica — franquia, dedupe por mensagem e liquidação só a partir de
 * `reserved`.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const ORG_A = "43100000-0000-4000-8000-000000000001";
const ORG_B = "43100000-0000-4000-8000-000000000002";
const ADMIN_A = "43100000-1111-4000-8000-000000000001";
const VIEWER_A = "43100000-1111-4000-8000-000000000002";
const ADMIN_B = "43100000-1111-4000-8000-000000000003";
const MSG = (n: number) => `43100000-3333-4000-8000-00000000000${n}`;

function como(user: string, query: string) {
  return lastLine(
    sql(`set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${user}"}', false);
    ${query}`),
  );
}

const reservar = (org: string, msg: string, segundos: number, limite = 60) =>
  lastLine(
    // `replica` desliga a checagem de FK só nesta sessão: as mensagens citadas
    // não existem, e montar conversa + contato aqui não mede nada da reserva.
    sql(`set session_replication_role = replica;
         select admitido || '|' || motivo || '|' || usados
           from public.fn_entendedor_reservar('${org}', '${msg}', ${segundos}, ${limite}, '2026-10-01');`),
  );

beforeAll(() => {
  sql(`insert into auth.users (id,email) values
      ('${ADMIN_A}','entendedor-admin-a@invariant.test'),
      ('${VIEWER_A}','entendedor-viewer-a@invariant.test'),
      ('${ADMIN_B}','entendedor-admin-b@invariant.test')
      on conflict do nothing;
    insert into organizations (id,slug,legal_name,display_name) values
      ('${ORG_A}','entendedor-a','Entendedor A','Entendedor A'),
      ('${ORG_B}','entendedor-b','Entendedor B','Entendedor B')
      on conflict do nothing;
    insert into user_organizations (user_id,organization_id,role,accepted_at) values
      ('${ADMIN_A}','${ORG_A}','admin',now()),
      ('${VIEWER_A}','${ORG_A}','viewer',now()),
      ('${ADMIN_B}','${ORG_B}','admin',now())
      on conflict do nothing;
    insert into audio_understanding_settings (organization_id, enabled) values
      ('${ORG_A}', true), ('${ORG_B}', true)
      on conflict do nothing;`);
});

describe("entendedor de áudio — RLS", () => {
  it("cada organização vê só a própria configuração", () => {
    expect(como(VIEWER_A, "select count(*) from audio_understanding_settings;")).toBe("1");
    expect(como(ADMIN_B, `select count(*) from audio_understanding_settings where organization_id='${ORG_A}';`)).toBe("0");
  });

  it("viewer não muda a configuração; admin só muda a da própria organização", () => {
    const desligar = (org: string) =>
      `with m as (update audio_understanding_settings set enabled=false where organization_id='${org}' returning 1) select count(*) from m;`;
    expect(como(VIEWER_A, desligar(ORG_A))).toBe("0");
    expect(como(ADMIN_B, desligar(ORG_A))).toBe("0");
    expect(como(ADMIN_A, desligar(ORG_A))).toBe("1");
  });

  it("ninguém escreve consumo pela REST, nem chama a reserva", () => {
    expect(() =>
      como(ADMIN_A, `insert into audio_understanding_usage (organization_id, period_start, seconds) values ('${ORG_A}','2026-10-01',1);`),
    ).toThrow();
    expect(() =>
      como(ADMIN_A, `select public.fn_entendedor_reservar('${ORG_A}', '${MSG(9)}', 1, 999999, '2026-10-01');`),
    ).toThrow();
  });
});

describe("entendedor de áudio — reserva atômica", () => {
  it("admite enquanto o áudio inteiro cabe, e recusa o que estoura", () => {
    expect(reservar(ORG_A, MSG(1), 40)).toBe("t|reservado|40");
    expect(reservar(ORG_A, MSG(2), 30)).toBe("f|franquia_esgotada|40");
    expect(reservar(ORG_A, MSG(3), 20)).toBe("t|reservado|60");
  });

  it("a mesma mensagem não reserva duas vezes", () => {
    expect(reservar(ORG_A, MSG(1), 40)).toBe("t|ja_reservado|60");
  });

  it("a franquia de uma organização não consome a da outra", () => {
    expect(reservar(ORG_B, MSG(4), 60)).toBe("t|reservado|60");
  });

  it("liberar devolve a franquia; cobrado nunca volta a liberado", () => {
    const liquidar = (msg: string, status: string) =>
      lastLine(sql(`set session_replication_role = replica; select public.fn_entendedor_liquidar('${ORG_A}', '${msg}', '${status}', null, 'teste');`));
    expect(liquidar(MSG(1), "released")).toBe("t");
    expect(reservar(ORG_A, MSG(5), 40)).toBe("t|reservado|60");
    expect(liquidar(MSG(3), "charged")).toBe("t");
    expect(liquidar(MSG(3), "released")).toBe("f");
    expect(reservar(ORG_A, MSG(3), 20)).toBe("f|ja_cobrado|60");
  });
});
