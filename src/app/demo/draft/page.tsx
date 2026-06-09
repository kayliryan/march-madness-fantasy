'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase/client';

interface Player {
  id: string;
  name: string;
  position: string;
  avg_ppg: number;
  team_name: string;
  team_seed: number;
}

interface RosterSlot {
  slot_key: string;
  slot_position: string;
  is_bench: boolean;
  player: Player;
}

interface Team {
  id: number;
  name: string;
  isHuman: boolean;
  roster: RosterSlot[];
}

const SLOT_SEQUENCE: { key: string; pos: 'G' | 'F' | 'C'; bench: boolean }[] = [
  { key: 'G1', pos: 'G', bench: false },
  { key: 'G2', pos: 'G', bench: false },
  { key: 'F1', pos: 'F', bench: false },
  { key: 'F2', pos: 'F', bench: false },
  { key: 'C1', pos: 'C', bench: false },
  { key: 'B1', pos: 'G', bench: true },
  { key: 'B2', pos: 'F', bench: true },
  { key: 'B3', pos: 'C', bench: true },
];

const N_TEAMS = 5;
const TOTAL_PICKS = N_TEAMS * SLOT_SEQUENCE.length;

const AI_NAMES = ['Balanced Bob', 'Guard Guru', 'Forward Fred', 'Seeds Stacy'];
// AI strategies: biases for position preference
const AI_POSITION_BIAS: Record<string, string | null> = {
  'Balanced Bob': null,
  'Guard Guru': 'G',
  'Forward Fred': 'F',
  'Seeds Stacy': null,
};

function getActiveTeamIndex(pickNumber: number): number {
  const round = Math.ceil(pickNumber / N_TEAMS);
  const pos = (pickNumber - 1) % N_TEAMS;
  return round % 2 === 1 ? pos : N_TEAMS - 1 - pos;
}

function getNextSlot(team: Team): { key: string; pos: 'G' | 'F' | 'C'; bench: boolean } | null {
  for (const slot of SLOT_SEQUENCE) {
    if (!team.roster.find((r) => r.slot_key === slot.key)) {
      return slot;
    }
  }
  return null;
}

function aiPickPlayer(team: Team, available: Player[]): Player | null {
  const nextSlot = getNextSlot(team);
  if (!nextSlot) return null;

  const bias = AI_POSITION_BIAS[team.name];

  // Seeds Stacy prefers lower seeds (higher seed number = more of an underdog)
  if (team.name === 'Seeds Stacy') {
    const candidates = available.filter((p) => p.position === nextSlot.pos);
    if (candidates.length > 0) {
      return candidates.reduce((best, p) => (p.team_seed > best.team_seed ? p : best));
    }
    return available[0] ?? null;
  }

  // Biased toward a position when available
  if (bias) {
    const preferred = available.filter((p) => p.position === bias && p.position === nextSlot.pos);
    if (preferred.length > 0) return preferred[0];
  }

  // Best available at required position, fallback to overall best
  const atPosition = available.filter((p) => p.position === nextSlot.pos);
  return atPosition[0] ?? available[0] ?? null;
}

export default function MockDraftPage() {
  const [allPlayers, setAllPlayers] = useState<Player[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [pickNumber, setPickNumber] = useState(1);
  const [draftComplete, setDraftComplete] = useState(false);
  const [posFilter, setPosFilter] = useState<string>('All');
  const [aiAdvice, setAiAdvice] = useState<string>('');
  const [adviceLoading, setAdviceLoading] = useState(false);
  const [loadingPlayers, setLoadingPlayers] = useState(true);
  const [aiProcessing, setAiProcessing] = useState(false);

  const draftedIds = new Set(
    teams.flatMap((t) => t.roster.map((r) => r.player.id))
  );
  const available = allPlayers.filter((p) => !draftedIds.has(p.id));
  const filtered = posFilter === 'All' ? available : available.filter((p) => p.position === posFilter);

  const activeTeamIdx = draftComplete ? -1 : getActiveTeamIndex(pickNumber);
  const activeTeam = teams[activeTeamIdx];
  const isHumanTurn = activeTeam?.isHuman === true;

  // Initialize teams
  useEffect(() => {
    const initial: Team[] = [
      { id: 0, name: 'You', isHuman: true, roster: [] },
      ...AI_NAMES.map((name, i) => ({ id: i + 1, name, isHuman: false, roster: [] })),
    ];
    setTeams(initial);
  }, []);

  // Load players
  useEffect(() => {
    fetch('/api/players?sort=avg_ppg_desc')
      .then((r) => r.json())
      .then((data) => {
        const players: Player[] = (data.players ?? []).map((p: {
          id: string; name: string; position: string; avg_ppg: number;
          teams?: { name: string; seed: number } | { name: string; seed: number }[] | null;
        }) => {
          const t = Array.isArray(p.teams) ? p.teams[0] : p.teams;
          return { id: p.id, name: p.name, position: p.position, avg_ppg: p.avg_ppg, team_name: t?.name ?? '—', team_seed: t?.seed ?? 0 };
        });
        setAllPlayers(players);
        setLoadingPlayers(false);
      })
      .catch(() => setLoadingPlayers(false));
  }, []);

  // Ensure anonymous session exists for AI advisor (requires auth.uid())
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) {
        supabase.auth.signInAnonymously().then(({ data: anonData }) => {
          if (anonData.user) {
            // Fire-and-forget: attach demo_viewer claim so write RLS blocks mutations
            fetch('/api/demo/session', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ user_id: anonData.user.id }),
            }).catch(() => {});
          }
        });
      }
    });
  }, []);

  const submitPick = useCallback((player: Player) => {
    setTeams((prev) => {
      const updated = prev.map((t) => {
        if (t.id !== prev[activeTeamIdx]?.id) return t;
        const nextSlot = getNextSlot(t);
        if (!nextSlot) return t;
        return {
          ...t,
          roster: [...t.roster, { slot_key: nextSlot.key, slot_position: nextSlot.pos, is_bench: nextSlot.bench, player }],
        };
      });
      return updated;
    });
    setPickNumber((n) => n + 1);
    setAiAdvice('');
  }, [activeTeamIdx]);

  // AI auto-picks with a delay
  useEffect(() => {
    if (draftComplete || isHumanTurn || loadingPlayers || teams.length === 0) return;
    if (pickNumber > TOTAL_PICKS) {
      setDraftComplete(true);
      return;
    }

    setAiProcessing(true);
    const timer = setTimeout(() => {
      const team = teams[getActiveTeamIndex(pickNumber)];
      const avail = allPlayers.filter((p) => !new Set(teams.flatMap((t) => t.roster.map((r) => r.player.id))).has(p.id));
      const pick = aiPickPlayer(team, avail);
      if (pick) submitPick(pick);
      setAiProcessing(false);
    }, 800);
    return () => clearTimeout(timer);
  }, [pickNumber, isHumanTurn, draftComplete, teams, allPlayers, loadingPlayers, submitPick]);

  useEffect(() => {
    if (pickNumber > TOTAL_PICKS) setDraftComplete(true);
  }, [pickNumber]);

  async function getAIAdvice() {
    setAdviceLoading(true);
    const humanTeam = teams.find((t) => t.isHuman)!;
    const nextSlot = getNextSlot(humanTeam);
    const unfilled_starters = SLOT_SEQUENCE
      .filter((s) => !s.bench && !humanTeam.roster.find((r) => r.slot_key === s.key))
      .map((s) => s.pos);
    const unfilled_bench = SLOT_SEQUENCE
      .filter((s) => s.bench && !humanTeam.roster.find((r) => r.slot_key === s.key))
      .length;

    const body = {
      available_players: available.slice(0, 50).map((p) => ({
        id: p.id, name: p.name, position: p.position, avg_ppg: p.avg_ppg,
        team_name: p.team_name, team_seed: p.team_seed,
      })),
      my_roster: humanTeam.roster.map((r) => ({
        slot_key: r.slot_key, slot_position: r.slot_position, is_bench: r.is_bench,
        player_name: r.player.name, avg_ppg: r.player.avg_ppg,
        team_name: r.player.team_name, team_seed: r.player.team_seed,
      })),
      pick_number: pickNumber,
      total_teams: N_TEAMS,
      unfilled_starters: [...new Set(unfilled_starters)].map((pos) => {
        const count = unfilled_starters.filter((p) => p === pos).length;
        return `${count}× ${pos}`;
      }),
      unfilled_bench,
      question: nextSlot ? `I need a ${nextSlot.bench ? 'bench' : 'starter'} ${nextSlot.pos}. Who should I pick?` : undefined,
    };

    try {
      const res = await fetch('/api/ai/mock-draft-advisor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      setAiAdvice(data.advice ?? 'No advice available.');
    } catch {
      setAiAdvice('Could not fetch advice — try again.');
    } finally {
      setAdviceLoading(false);
    }
  }

  const humanTeam = teams.find((t) => t.isHuman);
  const round = Math.ceil(pickNumber / N_TEAMS);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="border-b border-gray-200 bg-white px-4 py-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div>
            <span className="inline-flex items-center rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-700">
              Mock Draft
            </span>
            <h1 className="mt-1 text-lg font-bold text-gray-900">March Madness Fantasy 2026</h1>
          </div>
          <Link href="/demo/league" className="text-sm text-indigo-600 hover:underline">
            View Demo Standings
          </Link>
        </div>
      </div>

      {loadingPlayers ? (
        <div className="flex min-h-96 items-center justify-center">
          <p className="text-gray-500">Loading players…</p>
        </div>
      ) : draftComplete ? (
        <DraftComplete teams={teams} />
      ) : (
        <div className="mx-auto max-w-6xl px-4 py-6">
          {/* Draft status bar */}
          <div className="mb-4 flex items-center justify-between rounded-lg bg-white border border-gray-200 px-4 py-3 shadow-sm">
            <div className="flex items-center gap-4">
              <span className="text-sm text-gray-500">Pick {pickNumber} of {TOTAL_PICKS}</span>
              <span className="text-sm text-gray-500">Round {round}</span>
              <span className={`text-sm font-semibold ${isHumanTurn ? 'text-indigo-600' : 'text-gray-500'}`}>
                {aiProcessing ? `${activeTeam?.name} is picking…` : isHumanTurn ? 'Your turn' : `${activeTeam?.name}'s turn`}
              </span>
            </div>
            <div className="hidden sm:flex items-center gap-1">
              {teams.map((t, i) => (
                <div
                  key={t.id}
                  className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                    i === activeTeamIdx
                      ? t.isHuman ? 'bg-indigo-600 text-white' : 'bg-gray-700 text-white'
                      : 'bg-gray-100 text-gray-500'
                  }`}
                >
                  {t.isHuman ? 'You' : t.name.split(' ')[0]}
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            {/* Player pool */}
            <div className="lg:col-span-2">
              <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
                <div className="border-b border-gray-100 px-4 py-3">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <h2 className="text-sm font-semibold text-gray-900">Available Players</h2>
                    <div className="flex gap-1">
                      {['All', 'G', 'F', 'C'].map((pos) => (
                        <button
                          key={pos}
                          onClick={() => setPosFilter(pos)}
                          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                            posFilter === pos ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                          }`}
                        >
                          {pos}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* AI Advisor */}
                  {isHumanTurn && (
                    <div className="mt-3">
                      <button
                        onClick={getAIAdvice}
                        disabled={adviceLoading}
                        className="rounded-md bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 border border-indigo-200"
                      >
                        {adviceLoading ? '✦ Thinking…' : '✦ Ask AI Advisor'}
                      </button>
                      {aiAdvice && (
                        <div className="mt-2 rounded-md bg-indigo-50 border border-indigo-100 px-3 py-2">
                          <p className="text-xs text-indigo-800">{aiAdvice}</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="max-h-[480px] overflow-y-auto divide-y divide-gray-50">
                  {filtered.slice(0, 60).map((p) => (
                    <div key={p.id} className="flex items-center justify-between px-4 py-2.5 hover:bg-gray-50">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="w-5 shrink-0 text-center text-xs font-medium text-gray-400">{p.position}</span>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-gray-900">{p.name}</p>
                          <p className="text-xs text-gray-400">{p.team_name} #{p.team_seed} · {p.avg_ppg} PPG</p>
                        </div>
                      </div>
                      {isHumanTurn && (
                        <button
                          onClick={() => submitPick(p)}
                          className="ml-3 shrink-0 rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700"
                        >
                          Draft
                        </button>
                      )}
                    </div>
                  ))}
                  {filtered.length === 0 && (
                    <p className="px-4 py-6 text-center text-sm text-gray-400">No players available at this position.</p>
                  )}
                </div>
              </div>
            </div>

            {/* My roster */}
            <div>
              <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
                <div className="border-b border-gray-100 px-4 py-3">
                  <h2 className="text-sm font-semibold text-gray-900">Your Roster</h2>
                </div>
                <div className="p-3 space-y-1">
                  {SLOT_SEQUENCE.map((slot) => {
                    const filled = humanTeam?.roster.find((r) => r.slot_key === slot.key);
                    return (
                      <div
                        key={slot.key}
                        className={`flex items-center gap-2 rounded-md px-2.5 py-2 text-xs ${
                          filled ? 'bg-gray-50' : 'border border-dashed border-gray-200'
                        }`}
                      >
                        <span className="w-5 text-center font-medium text-gray-400">{slot.pos}</span>
                        {filled ? (
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium text-gray-900">{filled.player.name}</p>
                            <p className="text-gray-400">{filled.player.team_name} #{filled.player.team_seed}</p>
                          </div>
                        ) : (
                          <span className="text-gray-300">{slot.bench ? 'Bench ' : ''}{slot.pos} —</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DraftComplete({ teams }: { teams: Team[] }) {
  const humanTeam = teams.find((t) => t.isHuman)!;
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 text-center">
        <h2 className="text-2xl font-bold text-gray-900">Draft Complete!</h2>
        <p className="mt-1 text-sm text-gray-500">Here are your picks from the mock draft.</p>
      </div>

      {/* Human roster */}
      <div className="mb-6 rounded-lg border-2 border-indigo-200 bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-sm font-bold text-indigo-700 uppercase tracking-wide">Your Team</h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {humanTeam.roster.map((r) => (
            <div key={r.slot_key} className="rounded-md bg-indigo-50 p-2.5">
              <p className="text-xs font-medium text-indigo-400">{r.slot_key} · {r.slot_position}</p>
              <p className="mt-0.5 text-sm font-semibold text-gray-900 truncate">{r.player.name}</p>
              <p className="text-xs text-gray-500">{r.player.team_name} #{r.player.team_seed}</p>
              <p className="text-xs text-gray-400">{r.player.avg_ppg} PPG</p>
            </div>
          ))}
        </div>
      </div>

      {/* AI team summaries */}
      <div className="space-y-2">
        {teams.filter((t) => !t.isHuman).map((t) => (
          <div key={t.id} className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <button
              onClick={() => setExpanded(expanded === t.id ? null : t.id)}
              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50"
            >
              <span className="text-sm font-medium text-gray-900">{t.name}</span>
              <span className="text-xs text-gray-400">{expanded === t.id ? '▲ collapse' : '▼ expand'}</span>
            </button>
            {expanded === t.id && (
              <div className="grid grid-cols-2 gap-1.5 p-3 sm:grid-cols-4 border-t border-gray-100">
                {t.roster.map((r) => (
                  <div key={r.slot_key} className="rounded-md bg-gray-50 p-2">
                    <p className="text-xs text-gray-400">{r.slot_key}</p>
                    <p className="text-sm font-medium text-gray-900 truncate">{r.player.name}</p>
                    <p className="text-xs text-gray-500">#{r.player.team_seed} · {r.player.avg_ppg} PPG</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* CTA */}
      <div className="mt-8 rounded-lg border border-indigo-100 bg-indigo-50 p-6 text-center">
        <p className="font-semibold text-indigo-900">Like what you drafted?</p>
        <p className="mt-1 text-sm text-indigo-700">Create a real league and draft against your friends before March Madness starts.</p>
        <div className="mt-4 flex justify-center gap-3">
          <Link href="/auth/signup" className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700">
            Create account
          </Link>
          <Link href="/demo/league" className="rounded-md bg-white px-4 py-2 text-sm font-semibold text-indigo-600 border border-indigo-200 hover:bg-indigo-50">
            View demo league
          </Link>
        </div>
      </div>
    </div>
  );
}
