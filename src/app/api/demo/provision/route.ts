import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { DemoProvisioningService } from '@/lib/services/DemoProvisioningService';

// "Try as Commissioner" (Section 14.3). No auth required — provisions a fresh
// anonymous session + personal demo league on every call (no idempotency check;
// double-clicks create two sessions, cleaned up by /api/cron/demo-cleanup).
export async function POST() {
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

  // Step: anonymous session, no demo_viewer claim (provisioned commissioners get full write access)
  const { data: anonData, error: anonError } = await supabase.auth.signInAnonymously();
  if (anonError || !anonData.session || !anonData.user) {
    console.error('[demo/provision] signInAnonymously failed:', anonError);
    return NextResponse.json({ error: 'Failed to create demo session' }, { status: 500 });
  }

  try {
    const { league_id, draft_session_id } = await DemoProvisioningService.provision(anonData.user.id);

    const { session } = anonData;
    const expires_at = session.expires_at
      ? new Date(session.expires_at * 1000).toISOString()
      : new Date(Date.now() + session.expires_in * 1000).toISOString();

    return NextResponse.json(
      {
        league_id,
        draft_session_id,
        access_token: session.access_token,
        // Not part of the Section 14.2 DemoSession shape — included so the browser's
        // Supabase client (localStorage-based, separate from the cookie session set
        // above) can call setSession() and act as the provisioned commissioner.
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
