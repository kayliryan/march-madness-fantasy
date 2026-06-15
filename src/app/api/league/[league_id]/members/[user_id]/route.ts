import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { LeagueMember, UpdateMemberRoleRequest, UpdateMemberRoleResponse } from '@/lib/types';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ league_id: string; user_id: string }> }
) {
  try {
    const { league_id, user_id } = await params;
    const body: UpdateMemberRoleRequest = await request.json();

    if (body.role !== 'member' && body.role !== 'co_commissioner') {
      return NextResponse.json(
        { error: 'Invalid role. Must be "member" or "co_commissioner".' },
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

    if (user_id === user.id) {
      return NextResponse.json(
        { error: 'SELF_ROLE_CHANGE', message: 'You cannot change your own role.' },
        { status: 422 }
      );
    }

    const { data: requesterMember } = await supabase
      .from('league_members')
      .select('role')
      .eq('league_id', league_id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (requesterMember?.role !== 'commissioner') {
      return NextResponse.json(
        { error: 'Only the commissioner can change member roles' },
        { status: 403 }
      );
    }

    const { data: updated, error: updateError } = await supabase
      .from('league_members')
      .update({ role: body.role })
      .eq('league_id', league_id)
      .eq('user_id', user_id)
      .select()
      .single();

    if (updateError || !updated) {
      console.error('Error updating member role:', updateError);
      return NextResponse.json({ error: 'Failed to update member role' }, { status: 500 });
    }

    const response: UpdateMemberRoleResponse = { member: updated as LeagueMember };
    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in PATCH /api/league/[league_id]/members/[user_id]:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ league_id: string; user_id: string }> }
) {
  try {
    const { league_id, user_id } = await params;

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

    const { data: requesterMember } = await supabase
      .from('league_members')
      .select('role')
      .eq('league_id', league_id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (requesterMember?.role !== 'commissioner') {
      return NextResponse.json(
        { error: 'Only the commissioner can remove members' },
        { status: 403 }
      );
    }

    const { data: league, error: leagueError } = await supabase
      .from('leagues')
      .select('commissioner_id')
      .eq('id', league_id)
      .single();

    if (leagueError || !league) {
      return NextResponse.json({ error: 'League not found' }, { status: 404 });
    }

    if (user_id === league.commissioner_id) {
      return NextResponse.json(
        { error: 'CANNOT_REMOVE_COMMISSIONER', message: 'The league commissioner cannot be removed.' },
        { status: 422 }
      );
    }

    const { error: deleteError } = await supabase
      .from('league_members')
      .delete()
      .eq('league_id', league_id)
      .eq('user_id', user_id);

    if (deleteError) {
      console.error('Error removing member:', deleteError);
      return NextResponse.json({ error: 'Failed to remove member' }, { status: 500 });
    }

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error('Error in DELETE /api/league/[league_id]/members/[user_id]:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
