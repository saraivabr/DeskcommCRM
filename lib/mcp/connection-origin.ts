export function isFirstPartyConnectionRequest(request: Request, publicOrigin: string): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && (origin === new URL(request.url).origin || origin === publicOrigin);
}
