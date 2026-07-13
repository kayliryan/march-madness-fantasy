import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { checkAndIncrementDemoAiCap } from '@/lib/utils/demoAiCap';

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

    // Layer 3 (global daily) and Layer 4 (per-IP) caps apply to all demo AI routes
    // (no league_id = Layer 1 skipped).
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      ?? request.headers.get('x-real-ip')
      ?? 'unknown';
    const capResult = await checkAndIncrementDemoAiCap(null, ip);
    if (!capResult.allowed) {
      return NextResponse.json({ error: capResult.message }, { status: 429 });
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
      model: 'claude-sonnet-5',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const textBlock = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (!textBlock || !textBlock.text) {
      // Surfaced in production as a silent "No advice available." with no diagnosis
      // possible after the fact — log the full shape so a recurrence is debuggable,
      // and fail loudly to the client instead of a 200 with an empty body.
      console.error(
        '[mock-draft-advisor] No text block in Claude response.',
        JSON.stringify({ stop_reason: message.stop_reason, content_types: message.content.map((b) => b.type) })
      );
      return NextResponse.json(
        { error: 'The AI advisor had trouble responding just now — try again in a moment.' },
        { status: 502 }
      );
    }
    return NextResponse.json({ advice: textBlock.text });
  } catch (error) {
    console.error('Error in POST /api/ai/mock-draft-advisor:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
