import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { GetInvitesResponse, InviteListItem } from '@/lib/types';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ league_id: string }> }
) {
  try {
    const { league_id } = await params;

    if (!process.env.NEXT_PUBLIC_APP_URL) {
      return NextResponse.json(
        { error: 'MISSING_ENV', message: 'NEXT_PUBLIC_APP_URL is not configured.' },
        { status: 500 }
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

    const { data: league, error: leagueError } = await supabase
      .from('leagues')
      .select('id, commissioner_id')
      .eq('id', league_id)
      .single();

    if (leagueError || !league) {
      return NextResponse.json({ error: 'League not found' }, { status: 404 });
    }

    if (league.commissioner_id !== user.id) {
      return NextResponse.json(
        { error: 'Only the commissioner can view invites' },
        { status: 403 }
      );
    }

    const { data: invites, error: invitesError } = await supabase
      .from('league_invites')
      .select('id, invited_email, status, sent_at, accepted_at, expires_at, token')
      .eq('league_id', league_id)
      .in('status', ['pending', 'expired']);

    if (invitesError) {
      console.error('Error fetching invites:', invitesError);
      return NextResponse.json({ error: 'Failed to fetch invites' }, { status: 500 });
    }

    const now = new Date();

    const response: GetInvitesResponse = {
      invites: (invites || []).map((invite): InviteListItem => ({
        id: invite.id,
        invited_email: invite.invited_email,
        status:
          invite.status === 'expired' || new Date(invite.expires_at) < now
            ? 'expired'
            : 'pending',
        sent_at: invite.sent_at,
        accepted_at: invite.accepted_at ?? null,
        token: invite.token,
        invite_url: `${process.env.NEXT_PUBLIC_APP_URL}/league/invite/${invite.token}`,
      })),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in GET /api/league/[league_id]/invites:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
