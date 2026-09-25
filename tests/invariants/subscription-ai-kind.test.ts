import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { sql } from "./gov-helpers";

it("records an immutable usage kind on the existing tenant reservation", () => {
  const org = randomUUID();
  const other = randomUUID();
  const call = randomUUID();
  sql(`insert into organizations(id,slug,legal_name,display_name) values('${org}','kind-${org}','Synthetic','Synthetic');
    insert into org_subscriptions(organization_id,plan_id,provider_subscription_id,status,current_period_start,current_period_end)
    values('${org}','essencial','sub_${org}','active',now()-interval '1 day',now()+interval '29 days');
    select fn_reserve_subscription_ai('${org}','${call}');
    select fn_record_subscription_ai_kind('${org}','${call}','image');
    select fn_record_subscription_ai_kind('${org}','${call}','image');`);
  expect(
    sql(
      `select usage_kind from subscription_ai_reservations where id='${call}' and organization_id='${org}'`,
    ),
  ).toBe("image");
  expect(() => sql(`select fn_record_subscription_ai_kind('${org}','${call}','voice')`)).toThrow(
    /já registrado/,
  );
  expect(() => sql(`select fn_record_subscription_ai_kind('${other}','${call}','image')`)).toThrow(
    /não encontrada/,
  );
  expect(
    sql(
      `select has_function_privilege('authenticated','fn_record_subscription_ai_kind(uuid,uuid,text)','execute')`,
    ),
  ).toBe("f");
  expect(
    sql(
      `select has_function_privilege('anon','fn_record_subscription_ai_kind(uuid,uuid,text)','execute')`,
    ),
  ).toBe("f");
});
