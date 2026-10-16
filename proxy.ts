import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { isPublicPath } from "@/lib/auth/public-paths";
import { AUTH_TIMEOUT_MS, getUserWithDeadline, isAuthUnavailable } from "@/lib/auth/availability";
import { createAuthFetch } from "@/lib/supabase/auth-fetch";
import { fail } from "@/lib/api/wrappers";
import { logger } from "@/lib/logger";
import { safeNext } from "@/lib/auth/safe-next";
import {
  verifyImpersonateCookieEdge,
  IMPERSONATE_COOKIE_NAME_EDGE,
} from "@/lib/impersonate/cookie-edge";

const COOKIE_NAME = "sb-deskcomm-auth";

export async function proxy(request: NextRequest) {
  // Inject X-Request-Id for downstream correlation (audit log, error wrappers).
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const { pathname, search } = request.nextUrl;
  request.headers.set("x-request-id", requestId);
  request.headers.set("x-pathname", pathname);
  let response = NextResponse.next({ request: { headers: request.headers } });
  response.headers.set("x-request-id", requestId);
  response.headers.set("x-pathname", pathname);

  // Redirecionar ou responder 401 não pode perder o refresh/remoção que o SDK
  // acabou de gravar. Todos os caminhos autenticados também são não-cacheáveis.
  function finish(next: NextResponse, preserveSession = false): NextResponse {
    const cookies = response.cookies.getAll();
    const sessionCookie = (name: string) => name === COOKIE_NAME || name.startsWith(`${COOKIE_NAME}.`);
    // Refresh é um lote atômico: pode escrever .0 novo e apagar .1 antigo.
    // Preservar só os valores não vazios corromperia a sessão ao juntar chunks.
    const renewedSession = cookies.some((cookie) => sessionCookie(cookie.name) && cookie.value);
    for (const cookie of cookies) {
      if (preserveSession && !renewedSession && sessionCookie(cookie.name)) continue;
      next.cookies.set(cookie);
    }
    next.headers.set("x-request-id", requestId);
    next.headers.set("cache-control", "no-store, max-age=0");
    return next;
  }

  function unavailable(): NextResponse {
    const headers = { "Retry-After": "2" };
    if (pathname.startsWith("/api/")) {
      return finish(fail("auth_unavailable", "A verificação de acesso está temporariamente indisponível. Tente novamente.", 503, { requestId, headers }), true);
    }
    // Não renderiza o layout (que consulta o mesmo banco indisponível), nem
    // redireciona ao login. O destino continua sendo a página pedida.
    const retryUrl = safeNext(pathname + search, "/app").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
    return finish(new NextResponse(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Acesso temporariamente indisponível</title><body style="font-family:system-ui;max-width:38rem;margin:15vh auto;padding:2rem"><h1>Não foi possível verificar seu acesso agora</h1><p>O serviço demorou para responder. Sua sessão foi preservada.</p><p><a href="${retryUrl}">Tentar novamente</a></p></body></html>`, { status: 503, headers: { ...headers, "content-type": "text/html; charset=utf-8" } }), true);
  }
  if (pathname === "/legal/meta-data-deletion/status") {
    response.headers.set("cache-control", "no-store, max-age=0");
    response.headers.set("referrer-policy", "no-referrer");
    response.headers.set("x-robots-tag", "noindex, nofollow");
  }
  // Recupera retornos de OAuth social já emitidos antes da landing pública existir.
  // Apenas a navegação é tratada: o vínculo de conta segue protegido pelos guards canônicos.
  if (
    request.method === "GET" &&
    pathname === "/app/connections" &&
    request.nextUrl.searchParams.has("connected") &&
    request.nextUrl.searchParams.has("connect_token")
  ) {
    const landing = NextResponse.redirect(new URL("/auth/social-return", request.url));
    landing.headers.set("Cache-Control", "no-store");
    landing.headers.set("Referrer-Policy", "no-referrer");
    return landing;
  }
  // Expose pathname to Server Components via header (used by onboarding layout).

  // EPIC-11: the admin surface is reached by PATH (`/admin/*`) — the self-host kit
  // points `NEXT_PUBLIC_ADMIN_URL` at the same host as the app and maps no `admin.`
  // sub-domain. The host-based branch below stays a NOOP today and only exists as
  // documentation of the intended deploy topology.
  const host = request.headers.get("host") ?? "";
  const isAdminSurface = host.startsWith("admin.") || pathname.startsWith("/admin");

  if (isPublicPath(pathname)) {
    return response;
  }

  let acceptingCookies = true;
  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      global: { fetch: createAuthFetch(AbortSignal.timeout(AUTH_TIMEOUT_MS)) },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          if (!acceptingCookies) return;
          const previousCookies = response.cookies.getAll();
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          // NextResponse.next copia os headers. Reconstruir DEPOIS de atualizar
          // request.cookies é o que entrega o token novo ao handler/layout.
          response = NextResponse.next({ request: { headers: request.headers } });
          previousCookies.forEach((cookie) => response.cookies.set(cookie));
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
      cookieOptions: {
        name: COOKIE_NAME,
        sameSite: "strict",
        httpOnly: true,
        secure: cookieSecure(),
        path: "/",
      },
    },
  );

  // Validate JWT server-side (NEVER use getSession on backend per CLAUDE.md).
  let result;
  try {
    result = await getUserWithDeadline(() => supabase.auth.getUser());
  } catch {
    acceptingCookies = false;
    logger.warn("[auth] proxy não conseguiu verificar a sessão", { request_id: requestId });
    return unavailable();
  }
  acceptingCookies = false;
  const { data: { user }, error } = result;
  if (isAuthUnavailable(error)) {
    logger.warn("[auth] serviço de autenticação indisponível", { request_id: requestId, status: error?.status, code: error?.code });
    return unavailable();
  }

  if (error || !user) {
    // API routes must respond with JSON envelope (contract: {error:{code,message}})
    // — never redirect HTML to JSON consumers. UI routes redirect to /login as before.
    if (pathname.startsWith("/api/")) {
      return finish(fail("unauthenticated", "Entre novamente para continuar.", 401, { requestId }));
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname + search);
    return finish(NextResponse.redirect(loginUrl));
  }

  // EPIC-11 S-11.07: validate impersonate cookie on /app/* paths. Middleware
  // runs in Edge — no DB access, only HMAC + expiry. On any failure we delete
  // the presentation cookie. The database support session remains authoritative:
  // expired/revoked support still blocks the app until explicit exit.
  if (pathname.startsWith("/app")) {
    const impCookie = request.cookies.get(IMPERSONATE_COOKIE_NAME_EDGE)?.value;
    if (impCookie) {
      const result = await verifyImpersonateCookieEdge(
        impCookie,
        env.IMPERSONATE_COOKIE_SECRET ?? "",
      );
      if (!result.valid) {
        logger.warn("[auth] cookie de acompanhamento inválido", { reason: result.reason ?? "unknown" });
        response.cookies.delete(IMPERSONATE_COOKIE_NAME_EDGE);
      }
    }
  }

  // /admin/* additionally requires platform_admin (early gate — authoritative
  // check is server-side in `requirePlatformAdmin`). Skip the RPC for
  // `/admin/forbidden` (rendered to non-admins, would otherwise loop).
  if (isAdminSurface && pathname.startsWith("/admin") && pathname !== "/admin/forbidden") {
    const { data: isAdmin, error } = await supabase.rpc("fn_is_platform_admin");
    if (error) return unavailable();
    if (!isAdmin) return finish(NextResponse.redirect(new URL("/admin/forbidden", request.url)));
  }

  return finish(response);
}

export const config = {
  matcher: [
    // Run on all paths except static assets / Next internals.
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js)$).*)",
  ],
};
