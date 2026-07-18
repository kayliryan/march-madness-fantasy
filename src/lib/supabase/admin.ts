// Server-only Supabase client, constructed with the service-role key (bypasses RLS).
//
// The `server-only` package is not installed in this project (checked package.json),
// so the browser-import guard below is a manual runtime check instead of the usual
// `import 'server-only'` marker. Do NOT import this file from a 'use client' component
// or any code that ends up in a browser bundle — use `supabase` from `./client` there.
//
// The service-role client is built lazily (behind a Proxy) rather than at module load:
// `next build` statically imports route modules to classify them, which would run this
// module's top-level code even when SUPABASE_SERVICE_ROLE_KEY isn't set in the build
// environment. Deferring construction to first property access means the build stays
// clean while any real runtime use without the key still throws immediately and loudly
// — no silent fallback to the anon key.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

if (typeof window !== 'undefined') {
  throw new Error(
    'supabaseAdmin (service-role client) must not be imported in browser code. ' +
      'Import `supabase` from `@/lib/supabase/client` instead.'
  );
}

let cachedClient: SupabaseClient | null = null;

function getAdminClient(): SupabaseClient {
  if (cachedClient) return cachedClient;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error(
      'Missing SUPABASE_SERVICE_ROLE_KEY (or NEXT_PUBLIC_SUPABASE_URL) — supabaseAdmin ' +
        'requires real service-role credentials and will not silently fall back to the anon key.'
    );
  }

  cachedClient = createClient(supabaseUrl, supabaseServiceRoleKey);
  return cachedClient;
}

// Proxy defers client construction (and the env-var check above) until the first
// property/method access, e.g. `supabaseAdmin.from(...)`, so importing this module
// alone never throws — only actually using it without the service-role key does.
//
// Methods are bound to the real client (not the proxy) before being returned: the
// supabase-js client relies on private class fields internally, and calling a method
// with the proxy as `this` (which is what `proxy.method()` does by default) throws
// because the private-field WeakMap is keyed off the real instance, not the proxy.
export const supabaseAdmin: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = getAdminClient();
    const value = Reflect.get(client as object, prop, client);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
