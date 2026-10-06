import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

/** Dedicated client: aborting prepared-media I/O must not affect other work. */
export function createBoundedMetaAdminClient(signal?: AbortSignal) {
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: {
      headers: { "X-Client-Info": "meta-maintenance" },
      fetch: (input, init) => {
        const signals = [AbortSignal.timeout(15_000)];
        if (signal) signals.push(signal);
        if (init?.signal) signals.push(init.signal);
        if (input instanceof Request) signals.push(input.signal);
        return fetch(input, { ...init, signal: AbortSignal.any(signals) });
      },
    },
  });
}
