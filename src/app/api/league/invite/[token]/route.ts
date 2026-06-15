import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { LeagueInvite, UpdateInviteStatusRequest, UpdateInviteStatusResponse } from '@/lib/types';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    const body: UpdateInviteStatusRequest = await request.json();

    if (body.status !== 'expired') {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
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

    const { data: invite, error: inviteError } = await supabase
      .from('league_invites')
      .select('id, league_id')
      .eq('token', token)
      .single();

    if (inviteError || !invite) {
      return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
    }

    const { data: league, error: leagueError } = await supabase
      .from('leagues')
      .select('commissioner_id')
      .eq('id', invite.league_id)
      .single();

    if (leagueError || !league) {
      return NextResponse.json({ error: 'League not found' }, { status: 404 });
    }

    if (league.commissioner_id !== user.id) {
      return NextResponse.json(
        { error: 'Only the commissioner can update invites' },
        { status: 403 }
      );
    }

    const { data: updated, error: updateError } = await supabase
      .from('league_invites')
      .update({ status: 'expired' })
      .eq('token', token)
      .select()
      .single();

    if (updateError || !updated) {
      console.error('Error updating invite:', updateError);
      return NextResponse.json({ error: 'Failed to update invite' }, { status: 500 });
    }

    const response: UpdateInviteStatusResponse = { invite: updated as LeagueInvite };
    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in PATCH /api/league/invite/[token]:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
