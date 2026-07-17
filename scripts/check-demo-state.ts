import ws from 'ws';
import { createClient } from '@supabase/supabase-js';
if (!globalThis.WebSocket) { (globalThis as unknown as Record<string, unknown>).WebSocket = ws; }

async function main() {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const now = new Date().toISOString();
  const since24h = new Date(Date.now() - 24*60*60*1000).toISOString();

  const [leagues, log, daily] = await Promise.all([
    admin.from('leagues').select('id, is_demo, demo_expires_at, created_at').eq('is_demo', true),
    admin.from('demo_provision_log').select('*').gte('provisioned_at', since24h),
    admin.from('demo_ai_daily_usage').select('*'),
  ]);

  const active = (leagues.data ?? []).filter((l: { demo_expires_at: string | null }) => !l.demo_expires_at || l.demo_expires_at > now);
  console.log('=== All demo leagues:', (leagues.data ?? []).length, '(total)');
  console.log('=== Active (non-expired):', active.length, '/ cap:', 50);
  for (const l of active) {
    console.log(' ', (l as Record<string, unknown>).id, 'expires:', (l as Record<string, unknown>).demo_expires_at ?? 'never');
  }
  console.log();
  console.log('=== Provision log (last 24h):', (log.data ?? []).length, 'rows / per-IP cap: 5');
  const byIp: Record<string, number> = {};
  for (const row of (log.data ?? [])) { byIp[(row as Record<string, string>).ip] = (byIp[(row as Record<string, string>).ip] ?? 0) + 1; }
  console.log('Count per IP:', JSON.stringify(byIp));
  console.log();
  console.log('=== Daily AI usage:', JSON.stringify(daily.data));
}

main().catch((err) => { console.error(err); process.exit(1); });
