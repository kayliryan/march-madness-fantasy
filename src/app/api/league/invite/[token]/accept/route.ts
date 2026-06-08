import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { supabaseAdmin } from '@/lib/supabase/client';
import type { AcceptInviteResponse, LeagueMember, User } from '@/lib/types';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;

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
      data: { user: authUser },
    } = await supabase.auth.getUser();

    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Look up via admin client — the invitee isn't a league member yet, so RLS
    // would otherwise hide the invite row.
    const { data: invite, error: inviteError } = await supabaseAdmin
      .from('league_invites')
      .select('*')
      .eq('token', token)
      .single();

    if (inviteError || !invite) {
      return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
    }

    if (invite.status !== 'pending') {
      return NextResponse.json({ error: 'Invite is no longer valid' }, { status: 410 });
    }

    if (new Date(invite.expires_at).getTime() < Date.now()) {
      await supabaseAdmin
        .from('league_invites')
        .update({ status: 'expired' })
        .eq('id', invite.id);

      return NextResponse.json({ error: 'Invite has expired' }, { status: 410 });
    }

    // Already a member? Return the existing membership instead of erroring.
    const { data: existingMember } = await supabaseAdmin
      .from('league_members')
      .select('*')
      .eq('league_id', invite.league_id)
      .eq('user_id', authUser.id)
      .maybeSingle();

    let member = existingMember;

    if (!member) {
      const { data: newMember, error: memberError } = await supabaseAdmin
        .from('league_members')
        .insert({
          league_id: invite.league_id,
          user_id: authUser.id,
          role: 'member',
          joined_at: new Date().toISOString(),
          invited_by: invite.invited_by,
        })
        .select()
        .single();

      if (memberError || !newMember) {
        console.error('Error creating league member:', memberError);
        return NextResponse.json({ error: 'Failed to join league' }, { status: 500 });
      }

      member = newMember;
    }

    const { error: updateInviteError } = await supabaseAdmin
      .from('league_invites')
      .update({ status: 'accepted', accepted_at: new Date().toISOString() })
      .eq('id', invite.id);

    if (updateInviteError) {
      console.error('Error marking invite accepted:', updateInviteError);
    }

    const { data: userRecord, error: userError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', authUser.id)
      .single();

    if (userError || !userRecord) {
      console.error('Error fetching user record:', userError);
      return NextResponse.json({ error: 'Failed to load user record' }, { status: 500 });
    }

    const response: AcceptInviteResponse = {
      user: userRecord as User,
      league_member: member as LeagueMember,
    };

    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    console.error('Error in POST /api/league/invite/[token]/accept:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
