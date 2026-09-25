import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { sql } from "./gov-helpers";

it("lista de espera é privada da plataforma e serviço não recebe DELETE/TRUNCATE", () => {
  expect(
    sql("select relrowsecurity from pg_class where oid='public.sales_waitlist'::regclass"),
  ).toBe("t");
  for (const role of ["anon", "authenticated"]) {
    expect(() => sql(`set role ${role}; select * from sales_waitlist`)).toThrow(
      /permission denied/,
    );
    expect(() =>
      sql(
        `set role ${role}; insert into sales_waitlist(name,email) values('Pessoa','${randomUUID()}@example.test')`,
      ),
    ).toThrow(/permission denied/);
  }
  expect(() => sql("set role service_role; delete from sales_waitlist")).toThrow(
    /permission denied/,
  );
  expect(() => sql("set role service_role; truncate sales_waitlist")).toThrow(/permission denied/);
});
it("deduplica email sem provisionar organização ou usuário e permite marcar convite separado", () => {
  const email = `${randomUUID()}@example.test`;
  const users = sql("select count(*) from auth.users");
  const orgs = sql("select count(*) from organizations");
  sql(
    `set role service_role; insert into sales_waitlist(name,email) values('Pessoa','${email}') on conflict(email) do nothing; insert into sales_waitlist(name,email) values('Outra Pessoa','${email}') on conflict(email) do nothing`,
  );
  expect(sql(`select count(*) from sales_waitlist where email='${email}'`)).toBe("1");
  expect(sql(`select name from sales_waitlist where email='${email}'`)).toBe("Pessoa");
  expect(sql("select count(*) from auth.users")).toBe(users);
  expect(sql("select count(*) from organizations")).toBe(orgs);
  sql(
    `set role service_role; update sales_waitlist set invited_at=now(),updated_at=now() where email='${email}'`,
  );
  expect(sql(`select invited_at is not null from sales_waitlist where email='${email}'`)).toBe("t");
  expect(() =>
    sql(
      `insert into sales_waitlist(name,email) values('Pessoa','UPPER-${randomUUID()}@example.test')`,
    ),
  ).toThrow(/check constraint/);
});
