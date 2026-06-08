import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { supabaseAdmin } from '@/lib/supabase/client';
import type { LeagueInvite, SendInviteRequest, SendInviteResponse } from '@/lib/types';

const INVITE_EXPIRY_DAYS = 7;

// Stub email sender — logs to console for now (real Resend integration deferred to a later phase)
function sendInviteEmail(email: string, league_name: string, token: string) {
  console.log(
    `[stub email] Invite sent to ${email} for league "${league_name}" — accept at /league/invite/${token}`
  );
}

export async function POST(request: NextRequest) {
  try {
    const body: SendInviteRequest = await request.json();

    if (!body.league_id || !body.email) {
      return NextResponse.json(
        { error: 'Missing required fields: league_id, email' },
        { status: 400 }
      );
    }

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll() {},
        },
      }
    );

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Confirm the requester is the commissioner of this league (RLS also enforces this on insert)
    const { data: league, error: leagueError } = await supabase
      .from('leagues')
      .select('id, name, commissioner_id')
      .eq('id', body.league_id)
      .single();

    if (leagueError || !league) {
      return NextResponse.json({ error: 'League not found' }, { status: 404 });
    }

    if (league.commissioner_id !== user.id) {
      return NextResponse.json(
        { error: 'Only the commissioner can send invites' },
        { status: 403 }
      );
    }

    const token = `invite_${crypto.randomUUID()}`;
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const { data: invite, error: inviteError } = await supabase
      .from('league_invites')
      .insert({
        league_id: body.league_id,
        invited_email: body.email,
        invited_by: user.id,
        token,
        status: 'pending',
        sent_at: new Date().toISOString(),
        expires_at: expiresAt.toISOString(),
      })
      .select()
      .single();

    if (inviteError || !invite) {
      console.error('Error creating invite:', inviteError);
      return NextResponse.json({ error: 'Failed to create invite' }, { status: 500 });
    }

    sendInviteEmail(body.email, league.name, token);

    const response: SendInviteResponse = { invite: invite as LeagueInvite };
    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    console.error('Error in POST /api/league/invite:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token');

    if (!token) {
      return NextResponse.json({ error: 'Missing required query param: token' }, { status: 400 });
    }

    // Use the admin client: an invitee may not be a league member (or even signed in)
    // yet, so RLS would otherwise hide both the invite and the league it points to.
    const { data: invite, error: inviteError } = await supabaseAdmin
      .from('league_invites')
      .select('*, leagues(id, name, season)')
      .eq('token', token)
      .single();

    if (inviteError || !invite) {
      return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
    }

    return NextResponse.json({ invite });
  } catch (error) {
    console.error('Error in GET /api/league/invite:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
