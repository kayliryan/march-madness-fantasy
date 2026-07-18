import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';

// Attaches the demo_viewer JWT claim to an anonymous user.
// Flow: client calls supabase.auth.signInAnonymously() → gets user_id
//       → calls POST /api/demo/session with { user_id }
//       → this route verifies the user is anonymous, calls set-demo-claim Edge Function
//       → client calls supabase.auth.refreshSession() to pick up the updated JWT
//
// The demo_viewer claim activates RLS policies that block all write operations:
//   AND NOT (auth.jwt() ->> 'role' = 'demo_viewer')
// Supabase promotes app_metadata into the JWT root level, so that check works.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { user_id } = body as { user_id?: string };

    if (!user_id) {
      return NextResponse.json({ error: 'Missing user_id' }, { status: 400 });
    }

    // Verify the user exists and is anonymous — prevent real accounts from getting demo_viewer
    const { data: { user }, error: getUserError } = await supabaseAdmin.auth.admin.getUserById(user_id);
    if (getUserError || !user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    if (!user.is_anonymous) {
      return NextResponse.json({ error: 'Only anonymous users can get demo_viewer claim' }, { status: 403 });
    }

    // Already has the claim — nothing to do
    if (user.app_metadata?.role === 'demo_viewer') {
      return NextResponse.json({ ok: true, already_demo_user: true });
    }

    // Call the set-demo-claim Edge Function with service role authority
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    const fnUrl = `${supabaseUrl}/functions/v1/set-demo-claim`;
    const fnRes = await fetch(fnUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceRoleKey}`,
        'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      },
      body: JSON.stringify({ user_id }),
    });

    if (!fnRes.ok) {
      const detail = await fnRes.text().catch(() => '');
      console.error('[demo/session] set-demo-claim failed:', fnRes.status, detail);
      // Fall back to direct admin update if Edge Function is unavailable (e.g. local dev)
      const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(user_id, {
        app_metadata: { role: 'demo_viewer' },
      });
      if (updateError) {
        console.error('[demo/session] direct update also failed:', updateError.message);
        return NextResponse.json({ ok: false, error: 'claim_failed' }, { status: 500 });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Error in POST /api/demo/session:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
