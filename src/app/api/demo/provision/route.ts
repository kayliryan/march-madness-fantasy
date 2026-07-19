import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { Session } from '@supabase/supabase-js';
import { DemoProvisioningService } from '@/lib/services/DemoProvisioningService';
import { checkDemoProvisionAllowed, logDemoProvision } from '@/lib/utils/demoAiCap';

// "Try as Commissioner" (Section 14.3). No auth required — provisions a fresh
// anonymous session + personal demo league on every call (no idempotency check;
// double-clicks create two sessions, cleaned up by /api/cron/demo-cleanup).
export async function POST(request: NextRequest) {
  // Layer 2 checks: concurrent-league cap (primary backstop) + per-IP rate limit.
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip')
    ?? 'unknown';
  const capCheck = await checkDemoProvisionAllowed(ip);
  if (!capCheck.allowed) {
    const errorCode = capCheck.reason === 'concurrent_cap' ? 'CONCURRENT_CAP_REACHED' : 'RATE_LIMIT_IP';
    return NextResponse.json({ error: 'capacity', errorCode }, { status: 429 });
  }

  const response = NextResponse.json({});

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return []; },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Step: anonymous session, no demo_viewer claim (provisioned commissioners get
  // full write access). The shared AI-member pool check is independent of the anon
  // user, so overlap it with the GoTrue call — but keep both AFTER the cap check
  // above (a capped request must not create an anon session or pool users).
  let session: Session;
  let anonUserId: string;
  try {
    const [anonResult] = await Promise.all([
      supabase.auth.signInAnonymously(),
      DemoProvisioningService.ensureAiMemberPool(),
    ]);
    const { data: anonData, error: anonError } = anonResult;
    if (anonError || !anonData.session || !anonData.user) {
      console.error('[demo/provision] signInAnonymously failed:', anonError);
      return NextResponse.json({ error: 'Failed to create demo session' }, { status: 500 });
    }
    session = anonData.session;
    anonUserId = anonData.user.id;
  } catch (err) {
    console.error('[demo/provision] session/pool setup failed:', err);
    return NextResponse.json({ error: 'Failed to create demo session' }, { status: 500 });
  }

  try {
    const { league_id, draft_session_id } = await DemoProvisioningService.provision(anonUserId);
    // Fire-and-forget: this is a rate-limit log write, not a correctness gate —
    // don't spend a round trip of user-facing latency waiting on it.
    logDemoProvision(ip).catch((err) => console.error('[demo/provision] logDemoProvision failed:', err));

    const expires_at = session.expires_at
      ? new Date(session.expires_at * 1000).toISOString()
      : new Date(Date.now() + session.expires_in * 1000).toISOString();

    return NextResponse.json(
      {
        league_id,
        draft_session_id,
        access_token: session.access_token,
        // Not part of the Section 14.2 DemoSession shape — included so the browser's
        // Supabase client (cookie-based via createBrowserClient, separate from the
        // server cookie session set above) can call setSession() and act as the
        // provisioned commissioner.
        refresh_token: session.refresh_token,
        expires_at,
      },
      { headers: response.headers }
    );
  } catch (err) {
    console.error('[demo/provision] provisioning failed:', err);
    return NextResponse.json({ error: 'Failed to provision demo league' }, { status: 500 });
  }
}
