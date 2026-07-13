import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { supabaseAdmin } from '@/lib/supabase/client';
import Anthropic from '@anthropic-ai/sdk';
import { checkAndIncrementDemoAiCap } from '@/lib/utils/demoAiCap';

const anthropic = new Anthropic();

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { draft_session_id, question } = body as {
      draft_session_id: string;
      question?: string;
    };

    if (!draft_session_id) {
      return NextResponse.json({ error: 'Missing draft_session_id' }, { status: 400 });
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

    // Load draft session + league settings
    const { data: session } = await supabaseAdmin
      .from('draft_sessions')
      .select('*, leagues(id, settings, name, is_demo)')
      .eq('id', draft_session_id)
      .single();

    if (!session) {
      return NextResponse.json({ error: 'Draft session not found' }, { status: 404 });
    }

    // Verify user is a member of this league
    const { data: membership } = await supabase
      .from('league_members')
      .select('id')
      .eq('league_id', session.league_id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (!membership) {
      return NextResponse.json({ error: 'Not a member of this league' }, { status: 403 });
    }

    // Demo AI cap check (Layers 1, 3 + 4). Real leagues are uncapped.
    const leagueIsDemo = (session.leagues as { is_demo?: boolean } | null)?.is_demo === true;
    if (leagueIsDemo) {
      const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        ?? request.headers.get('x-real-ip')
        ?? 'unknown';
      const capResult = await checkAndIncrementDemoAiCap(session.league_id, ip);
      if (!capResult.allowed) {
        return NextResponse.json({ error: capResult.message }, { status: 429 });
      }
    }

    const settings = session.leagues?.settings as Record<string, unknown> | null;
    const starterSlots = (settings?.starter_slots as Record<string, number>) ?? { G: 2, F: 2, C: 1 };
    const benchSlots = (settings?.bench_slots as number) ?? 3;

    // Current pick context
    const pickNumber = session.current_pick_number ?? 1;
    const n = (session.snake_order as string[] | null)?.length ?? 1;
    const roundNumber = Math.ceil(pickNumber / n);

    // User's current roster in this session
    const { data: mySlots } = await supabaseAdmin
      .from('roster_slots')
      .select('slot_key, slot_position, is_bench, players(id, name, position, avg_ppg, teams(name, seed))')
      .eq('league_id', session.league_id)
      .eq('user_id', user.id)
      .eq('is_active', true)
      .is('released_at_round_stage', null);

    type SlotPlayer = { name: string; position: string; avg_ppg: number; teams: { name: string; seed: number } | null } | null;
    const myRoster = (mySlots ?? []).map((s) => {
      const p = s.players as unknown as SlotPlayer;
      const t = Array.isArray(p?.teams) ? (p?.teams as { name: string; seed: number }[])[0] ?? null : p?.teams ?? null;
      return `${s.slot_key} (${s.is_bench ? 'bench' : 'starter'}): ${p?.name ?? '?'} ${p?.position ?? ''} ${t ? `${t.name} seed-${t.seed}` : ''} ${p?.avg_ppg ?? 0} PPG`;
    });

    // Compute unfilled positions
    const filledStarters: Record<string, number> = { G: 0, F: 0, C: 0 };
    const starters = (mySlots ?? []).filter((s) => !s.is_bench);
    for (const s of starters) {
      const pos = s.slot_position as 'G' | 'F' | 'C';
      filledStarters[pos] = (filledStarters[pos] ?? 0) + 1;
    }
    const unfilledPositions: string[] = [];
    for (const [pos, required] of Object.entries(starterSlots)) {
      const filled = filledStarters[pos as 'G' | 'F' | 'C'] ?? 0;
      if (filled < required) {
        unfilledPositions.push(`${required - filled}× ${pos}`);
      }
    }
    const benchCount = (mySlots ?? []).filter((s) => s.is_bench).length;
    const unfilledBench = benchSlots - benchCount;

    // Available players (top 30 by PPG, not yet drafted)
    const { data: draftedRows } = await supabaseAdmin
      .from('draft_picks')
      .select('player_id')
      .eq('draft_session_id', draft_session_id)
      .is('voided_at', null);

    const draftedIds = new Set((draftedRows ?? []).map((r: { player_id: string }) => r.player_id));

    const { data: allPlayers } = await supabaseAdmin
      .from('players')
      .select('id, name, position, avg_ppg, teams(name, seed)')
      .order('avg_ppg', { ascending: false })
      .limit(200);

    type AvailPlayer = { id: string; name: string; position: string; avg_ppg: number; teams: { name: string; seed: number } | { name: string; seed: number }[] | null };
    const undrafted = (allPlayers as unknown as AvailPlayer[] ?? []).filter((p) => !draftedIds.has(p.id));

    // Group by position and take top 10 per group — avoids biasing advice toward one position
    const byPosition: Record<string, AvailPlayer[]> = { G: [], F: [], C: [] };
    for (const p of undrafted) {
      const pos = p.position as 'G' | 'F' | 'C';
      if (byPosition[pos]) byPosition[pos].push(p);
    }
    const formatPlayer = (p: AvailPlayer) => {
      const t = Array.isArray(p.teams) ? p.teams[0] ?? null : p.teams;
      return `  ${p.name} ${t ? `${t.name} seed-${t.seed}` : ''} ${p.avg_ppg} PPG`;
    };
    const availableSections = (['G', 'F', 'C'] as const).map((pos) => {
      const top = byPosition[pos].slice(0, 10);
      return top.length > 0 ? `${pos} (${top.length} available):\n${top.map(formatPlayer).join('\n')}` : '';
    }).filter(Boolean);

    const systemPrompt = `You are an expert March Madness fantasy basketball advisor helping with a snake draft.

League: ${session.leagues?.name ?? 'Unknown'}
Current pick: #${pickNumber} (Round ${roundNumber})
Starter slots needed: ${Object.entries(starterSlots).map(([k, v]) => `${v}× ${k}`).join(', ')}
Bench slots: ${benchSlots}

User's current roster (${myRoster.length} players):
${myRoster.length > 0 ? myRoster.join('\n') : '(empty — first picks)'}

Unfilled needs: ${unfilledPositions.length > 0 ? unfilledPositions.join(', ') : 'starters complete'}, bench: ${unfilledBench > 0 ? `${unfilledBench} spots` : 'full'}

Available undrafted players by position (top 10 each by avg PPG):
${availableSections.join('\n\n')}

Give concise, specific draft advice (2–3 sentences). Consider position need, seed-based elimination risk, and PPG value.`;

    const userPrompt = question?.trim() || 'Who should I pick right now and why?';

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const advice = (message.content[0] as { type: string; text: string }).text;
    return NextResponse.json({ advice });
  } catch (error) {
    console.error('Error in POST /api/ai/draft-advisor:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
