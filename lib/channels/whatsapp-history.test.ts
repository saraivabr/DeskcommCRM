import { describe, expect, it } from "vitest";
import { historySentAt, identityFromHistoryChat } from "./whatsapp-history";

describe("histórico anterior do WhatsApp", () => {
  it("aceita apenas chats de pessoa, inclusive LID, e não confunde grupo com contato", () => {
    expect(identityFromHistoryChat("5511999999999@c.us")).toEqual({ kind: "phone", value: "+5511999999999" });
    expect(identityFromHistoryChat("12345678901234567@lid")).toEqual({ kind: "lid", value: "12345678901234567" });
    expect(identityFromHistoryChat("5511999999999@g.us")).toBeNull();
    expect(identityFromHistoryChat("status@broadcast")).toBeNull();
  });

  it("converte segundos e milissegundos sem aceitar timestamps futuros", () => {
    expect(historySentAt(1_700_000_000)).toBe("2023-11-14T22:13:20.000Z");
    expect(historySentAt(1_700_000_000_000)).toBe("2023-11-14T22:13:20.000Z");
    expect(historySentAt(Date.now() + 90_000_000)).toBeNull();
  });
});
