import { afterEach, expect, it, vi } from "vitest";
import { normalizeInstagramProspect } from "@/lib/prospecting/instagram";
import { startSearch } from "@/lib/prospecting/provider";
import { searchSchema } from "@/lib/prospecting/schema";

afterEach(() => vi.unstubAllGlobals());

it("searches Instagram with one bounded keyword and no messaging side effect", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ data: { id: "run", status: "RUNNING" } })));
  vi.stubGlobal("fetch", fetch);
  await startSearch(
    "test-key",
    searchSchema.parse({
      source: "instagram",
      name: "Teste",
      niche: "Clínicas",
      location: "São Paulo, SP",
      limit: 5,
      budget_usd: 0.5,
      enrich: false,
    }),
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe(
    "https://api.apify.com/v2/acts/apify~instagram-search-scraper/runs?maxItems=5&maxTotalChargeUsd=0.5&timeout=300",
  );
  expect(JSON.parse(init.body)).toEqual({
    search: "Clínicas São Paulo SP",
    searchType: "user",
    searchLimit: 5,
    enhanceUserSearchWithFacebookPage: false,
  });
  expect(init.headers.Authorization).toBe("Bearer test-key");
});

it("retains public profiles without inventing a WhatsApp phone or Maps URL", () => {
  expect(
    normalizeInstagramProspect({
      id: "123",
      username: "empresa.teste",
      fullName: "Empresa",
      externalUrl: "https://example.test",
    }),
  ).toMatchObject({
    key: "instagram:123",
    name: "Empresa",
    phone: null,
    maps_url: null,
    socials: ["https://www.instagram.com/empresa.teste/"],
  });
  expect(
    normalizeInstagramProspect({ username: "EMPRESA", businessPhoneNumber: "+5511999990000" }),
  ).toMatchObject({ key: "instagram:empresa", phone: "+5511999990000" });
  expect(
    normalizeInstagramProspect({ username: "empresa", businessPhoneNumber: "+12125551234" })?.phone,
  ).toBeNull();
});

it("rejects private and malformed profiles and unsafe external links", () => {
  expect(normalizeInstagramProspect({ username: "empresa", isPrivate: true })).toBeNull();
  expect(normalizeInstagramProspect({ username: "../bad" })).toBeNull();
  expect(normalizeInstagramProspect({ error: "not found" })).toBeNull();
  expect(
    normalizeInstagramProspect({ username: "empresa", externalUrl: "javascript:alert(1)" })
      ?.website,
  ).toBeNull();
  expect(
    searchSchema.safeParse({ source: "unknown", name: "Teste", niche: "Teste", location: "SP" })
      .success,
  ).toBe(false);
});
