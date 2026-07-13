import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { supabaseAdmin } from '@/lib/supabase/client';
import Anthropic from '@anthropic-ai/sdk';
import { ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
import type { RoundStage } from '@/lib/constants/rounds';
import { checkAndIncrementDemoAiCap, DEMO_AI_CAP_MESSAGE } from '@/lib/utils/demoAiCap';

const anthropic = new Anthropic();

const ROUND_LABELS: Record<string, string> = {
  play_in: 'Play-In',
  r64: 'Round of 64',
  r32: 'Round of 32',
  s16: 'Sweet 16',
  e8: 'Elite 8',
  f4: 'Final Four',
  championship: 'Championship',
};

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { league_id } = body as { league_id: string };

    if (!league_id) {
      return NextResponse.json({ error: 'Missing league_id' }, { status: 400 });
    }

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return request.cookies.getAll(); },
          setAll() {},
        },
      }
    );

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Verify membership
    const { data: membership } = await supabase
      .from('league_members')
      .select('id')
      .eq('league_id', league_id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (!membership) {
      return NextResponse.json({ error: 'Not a member of this league' }, { status: 403 });
    }

    // Fetch league info
    const { data: league } = await supabaseAdmin
      .from('leagues')
      .select('name, is_demo')
      .eq('id', league_id)
      .single();

    // Demo AI cap check (Layers 1 + 3). Real leagues are uncapped.
    if (league?.is_demo) {
      const capResult = await checkAndIncrementDemoAiCap(league_id);
      if (!capResult.allowed) {
        return NextResponse.json({ error: DEMO_AI_CAP_MESSAGE }, { status: 429 });
      }
    }

    // Fetch standings snapshots
    const { data: snapshots } = await supabaseAdmin
      .from('leaderboard_snapshots')
      .select('user_id, total_points, active_player_count, highest_single_game_points, round_stage')
      .eq('league_id', league_id)
      .order('total_points', { ascending: false });

    if (!snapshots?.length) {
      return NextResponse.json({ narrative: "The tournament hasn't started yet — check back once games begin!" });
    }

    // Fetch display names
    const userIds = snapshots.map((s: { user_id: string }) => s.user_id);
    const { data: users } = await supabaseAdmin
      .from('users')
      .select('id, display_name')
      .in('id', userIds);

    const nameMap = new Map((users ?? []).map((u: { id: string; display_name: string }) => [u.id, u.display_name]));

    // Fetch per-round breakdown
    const { data: events } = await supabaseAdmin
      .from('scoring_events')
      .select('user_id, round_stage, points_credited')
      .eq('league_id', league_id)
      .eq('is_stale', false);

    type PerRound = Map<string, number>;
    const perRoundByUser = new Map<string, PerRound>();
    for (const ev of (events ?? [])) {
      if (!perRoundByUser.has(ev.user_id)) perRoundByUser.set(ev.user_id, new Map());
      const pr = perRoundByUser.get(ev.user_id)!;
      pr.set(ev.round_stage, (pr.get(ev.round_stage) ?? 0) + ev.points_credited);
    }

    const currentStage = snapshots[0]?.round_stage as RoundStage | undefined;
    const stageName = currentStage ? (ROUND_LABELS[currentStage] ?? currentStage) : 'Pre-Tournament';

    const standingsSummary = snapshots.map((s: { user_id: string; total_points: number; active_player_count: number; highest_single_game_points: number }, i: number) => {
      const name = nameMap.get(s.user_id) ?? 'Unknown';
      const pr = perRoundByUser.get(s.user_id);
      const breakdown = pr
        ? [...pr.entries()]
            .sort(([a], [b]) => ROUND_STAGE_ORDER.indexOf(a as RoundStage) - ROUND_STAGE_ORDER.indexOf(b as RoundStage))
            .map(([stage, pts]) => `${ROUND_LABELS[stage] ?? stage}: ${pts}`)
            .join(', ')
        : 'no scores yet';
      return `${i + 1}. ${name} — ${s.total_points} pts (${s.active_player_count} active players, best game: ${s.highest_single_game_points}) | ${breakdown}`;
    }).join('\n');

    const systemPrompt = `You are a witty, engaging March Madness fantasy sports analyst. Generate a lively 2–3 sentence narrative about the current standings. Highlight the leader's dominant stats, any surprising upsets or performances, and the tightest race. Use basketball and tournament language. Keep it fun and conversational.`;

    const userPrompt = `League: ${league?.name ?? 'Unknown'}
Current stage: ${stageName}

Standings:
${standingsSummary}`;

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const narrative = (message.content[0] as { type: string; text: string }).text;
    return NextResponse.json({ narrative });
  } catch (error) {
    console.error('Error in POST /api/ai/standings-narrator:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
