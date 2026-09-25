import { normalizeProspect, safePublicLink, type Prospect } from "./schema";

/** Public profile search only. A scraped username is not a messaging-scoped ID. */
export function normalizeInstagramProspect(item: Record<string, unknown>): Prospect | null {
  const username = typeof item.username === "string" ? item.username.trim() : "";
  if (!/^[a-zA-Z0-9._]{1,30}$/.test(username) || item.isPrivate === true) return null;
  const id =
    typeof item.id === "string" && /^\d+$/.test(item.id) ? item.id : username.toLowerCase();
  const profile = `https://www.instagram.com/${username}/`;
  const email = item.businessEmail ?? item.business_email;
  return normalizeProspect({
    title: item.fullName || username,
    placeId: `instagram:${id}`,
    phone: item.businessPhoneNumber ?? item.business_phone_number ?? item.phone,
    website: typeof item.externalUrl === "string" ? safePublicLink(item.externalUrl) : null,
    categoryName: item.businessCategoryName ?? item.business_category_name,
    address: item.businessAddress ?? item.address,
    instagrams: [profile],
    emails: typeof email === "string" ? [email] : [],
  });
}
