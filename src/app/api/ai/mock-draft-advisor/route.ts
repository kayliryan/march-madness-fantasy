import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

interface PlayerSummary {
  id: string;
  name: string;
  position: string;
  avg_ppg: number;
  team_name: string;
  team_seed: number;
}

interface SlotSummary {
  slot_key: string;
  slot_position: string;
  is_bench: boolean;
  player_name: string;
  avg_ppg: number;
  team_name: string;
  team_seed: number;
}

// Mock draft advisor — accepts player pool state directly in the request body.
// No draft_session_id needed, so demo users (anonymous auth) can call this.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      available_players,
      my_roster,
      pick_number,
      total_teams,
      unfilled_starters,
      unfilled_bench,
      question,
    } = body as {
      available_players: PlayerSummary[];
      my_roster: SlotSummary[];
      pick_number: number;
      total_teams: number;
      unfilled_starters: string[];
      unfilled_bench: number;
      question?: string;
    };

    if (!available_players || !my_roster || !pick_number) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Require auth (anonymous or real) to prevent unauthenticated API abuse
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

    const n = total_teams ?? 5;
    const roundNumber = Math.ceil(pick_number / n);

    // Group available players by position, top 10 each
    const byPosition: Record<string, PlayerSummary[]> = { G: [], F: [], C: [] };
    for (const p of available_players) {
      if (byPosition[p.position]) byPosition[p.position].push(p);
    }
    const formatP = (p: PlayerSummary) => `  ${p.name} ${p.team_name} seed-${p.team_seed} ${p.avg_ppg} PPG`;
    const availableSections = (['G', 'F', 'C'] as const).map((pos) => {
      const top = byPosition[pos].slice(0, 10);
      return top.length > 0 ? `${pos} (${top.length} available):\n${top.map(formatP).join('\n')}` : '';
    }).filter(Boolean);

    const rosterLines = my_roster.map((s) =>
      `${s.slot_key} (${s.is_bench ? 'bench' : 'starter'}): ${s.player_name} ${s.slot_position} ${s.team_name} seed-${s.team_seed} ${s.avg_ppg} PPG`
    );

    const systemPrompt = `You are an expert March Madness fantasy basketball advisor helping with a mock draft.

Current pick: #${pick_number} (Round ${roundNumber}, ${n}-team league)
Unfilled starters needed: ${unfilled_starters.length > 0 ? unfilled_starters.join(', ') : 'none (starters complete)'}
Bench spots remaining: ${unfilled_bench}

Your current roster (${my_roster.length} players):
${rosterLines.length > 0 ? rosterLines.join('\n') : '(empty — first picks)'}

Available undrafted players by position (top 10 each by avg PPG):
${availableSections.join('\n\n')}

Give concise, specific draft advice (2–3 sentences). Consider position need, seed-based elimination risk, and PPG value.`;

    const userPrompt = question?.trim() || 'Who should I pick right now and why?';

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const advice = (message.content[0] as { type: string; text: string }).text;
    return NextResponse.json({ advice });
  } catch (error) {
    console.error('Error in POST /api/ai/mock-draft-advisor:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
