/**
 * One-off verification: simulate the browser login flow using @supabase/ssr's
 * createServerClient with an in-memory cookie jar (same cookie shapes a real
 * browser would get from createBrowserClient), then replay those cookies
 * against the running dev server's middleware-protected routes.
 *
 * Usage: npx tsx --env-file=.env.local scripts/verify-auth-fix.ts
 */

import '@/lib/utils/wsPolyfill';
import { createServerClient } from '@supabase/ssr';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const APP_URL = 'http://localhost:3000';

const EMAIL = 'pooka@real2026.marchfantasy.app';
const PASSWORD = 'realmadness2026';
const USER_ID = '0e8531d2-c56e-4e0b-aeaa-b366e650d83f';
const LEAGUE_ID = '00000000-0000-0000-0000-000000000002';

async function run() {
  const jar = new Map<string, string>();

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return [...jar.entries()].map(([name, value]) => ({ name, value }));
      },
      setAll(cookies) {
        for (const { name, value } of cookies) jar.set(name, value);
      },
    },
  });

  const { data, error } = await supabase.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (error) throw new Error(`signIn failed: ${error.message}`);
  console.log(`Signed in as ${data.user?.email} (${data.user?.id})`);

  console.log('\nCookies that would be set in the browser:');
  for (const [name] of jar) console.log(`  ${name}`);

  const cookieHeader = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');

  for (const path of [
    '/dashboard',
    `/league/${LEAGUE_ID}/roster/${USER_ID}`,
    `/league/${LEAGUE_ID}/leaderboard`,
  ]) {
    const res = await fetch(`${APP_URL}${path}`, {
      headers: { Cookie: cookieHeader },
      redirect: 'manual',
    });
    console.log(`\nGET ${path} -> ${res.status} ${res.headers.get('location') ?? ''}`);
  }

  // Also check the API route directly
  const apiRes = await fetch(`${APP_URL}/api/league/${LEAGUE_ID}/roster/${USER_ID}`, {
    headers: { Cookie: cookieHeader },
  });
  console.log(`\nGET /api/league/${LEAGUE_ID}/roster/${USER_ID} -> ${apiRes.status}`);
  if (apiRes.ok) {
    const json = await apiRes.json();
    console.log(`  active_starters: ${json.active_starters?.length}, active_bench: ${json.active_bench?.length}`);
  } else {
    console.log(`  body: ${await apiRes.text()}`);
  }
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
