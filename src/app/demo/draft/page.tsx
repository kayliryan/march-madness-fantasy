'use client';

import { Fragment, useEffect, useState, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase/client';
import type { RoundStage } from '@/lib/constants/rounds';
import { buildInitialField, simulateBracketRound, REGION_ORDER, type BracketTeam } from '@/lib/utils/bracketSim';
import { getRoundCell } from '@/lib/utils/roundBreakdown';
import { RoundCellBadge } from '@/components/RoundCellBadge';
import { NcaaBracketView } from '@/components/NcaaBracketView';

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

const SLOT_SEQUENCE: { key: string; pos: 'G' | 'F' | 'C' | null; bench: boolean; label: string }[] = [
  { key: 'G1', pos: 'G', bench: false, label: 'Guard 1' },
  { key: 'G2', pos: 'G', bench: false, label: 'Guard 2' },
  { key: 'F1', pos: 'F', bench: false, label: 'Forward 1' },
  { key: 'F2', pos: 'F', bench: false, label: 'Forward 2' },
  { key: 'C1', pos: 'C', bench: false, label: 'Center' },
  { key: 'B1', pos: null, bench: true, label: 'Bench' },
  { key: 'B2', pos: null, bench: true, label: 'Bench' },
  { key: 'B3', pos: null, bench: true, label: 'Bench' },
];

const N_TEAMS = 5;
const TOTAL_PICKS = N_TEAMS * SLOT_SEQUENCE.length;

const AI_TEAMS = [
  { name: 'Lauren', bias: null as string | null },
  { name: 'Sophie', bias: 'G' },
  { name: 'Sienna', bias: 'F' },
  { name: 'Jake',   bias: null },
];

type PosFilter = 'All' | 'G' | 'F' | 'C' | 'Teams';

function getActiveTeamIndex(pickNumber: number): number {
  const round = Math.ceil(pickNumber / N_TEAMS);
  const pos = (pickNumber - 1) % N_TEAMS;
  return round % 2 === 1 ? pos : N_TEAMS - 1 - pos;
}

// Returns the first unfilled slot matching player's position (for starters),
// then falls back to the next bench slot only once ALL starters are filled.
function getSlotForPlayer(team: Team, player: Player): typeof SLOT_SEQUENCE[number] | null {
  // Try a matching unfilled starter slot first
  for (const slot of SLOT_SEQUENCE) {
    if (!slot.bench && slot.pos === player.position && !team.roster.find((r) => r.slot_key === slot.key)) {
      return slot;
    }
  }
  // Don't allow bench overflow until every starter slot is filled
  const allStartersFilled = SLOT_SEQUENCE.filter((s) => !s.bench).every((s) => team.roster.find((r) => r.slot_key === s.key));
  if (!allStartersFilled) return null;
  // Fall back to next bench slot
  for (const slot of SLOT_SEQUENCE) {
    if (slot.bench && !team.roster.find((r) => r.slot_key === slot.key)) return slot;
  }
  return null;
}

// AI still picks sequentially (by slot order) so it fills predictably
function getNextSlotSequential(team: Team): typeof SLOT_SEQUENCE[number] | null {
  for (const slot of SLOT_SEQUENCE) {
    if (!team.roster.find((r) => r.slot_key === slot.key)) return slot;
  }
  return null;
}

// Timeout auto-pick for the human team (Section 4.4 "Race 2" + commissioner request edge cases):
// 1. Queue-first — walk the queue in order and take the first queued, available player that's
//    currently draftable (fills an open starter slot, or bench once all starters are filled).
//    A later queue entry never jumps ahead of an earlier one just because it matches the
//    "next" slot — the top of the queue wins as long as it's allowed.
// 2. Otherwise, highest-PPG available player matching the position the next slot needs
//    (`available` is pre-sorted by avg_ppg desc).
// 3. If the next slot is an open bench slot (no position requirement), highest-PPG available player overall.
function getAutoPickForHuman(team: Team, available: Player[], queue: Player[], draftedIds: Set<string>): Player | null {
  for (const p of queue) {
    if (draftedIds.has(p.id)) continue;
    if (getSlotForPlayer(team, p)) return p;
  }
  const nextSlot = getNextSlotSequential(team);
  if (!nextSlot) return null;
  if (nextSlot.bench) return available[0] ?? null;
  const atPos = available.filter((p) => p.position === nextSlot.pos);
  return atPos[0] ?? available[0] ?? null;
}

const TIMER_OPTIONS = [
  { label: '30s (demo)', value: 30 },
  { label: '90s (default)', value: 90 },
  { label: '5 min', value: 300 },
  { label: 'Off', value: null },
] as const;

function aiPickPlayer(team: Team, available: Player[]): Player | null {
  const nextSlot = getNextSlotSequential(team);
  if (!nextSlot) return null;
  if (nextSlot.bench) return available[0] ?? null;
  if (team.name === 'Jake') {
    const at = available.filter((p) => p.position === nextSlot.pos);
    if (at.length > 0) return at.reduce((best, p) => (p.team_seed > best.team_seed ? p : best));
    return available[0] ?? null;
  }
  const bias = AI_TEAMS.find((t) => t.name === team.name)?.bias ?? null;
  if (bias && bias === nextSlot.pos) {
    const preferred = available.filter((p) => p.position === bias);
    if (preferred.length > 0) return preferred[0];
  }
  const atPos = available.filter((p) => p.position === nextSlot.pos);
  return atPos[0] ?? available[0] ?? null;
}

export default function MockDraftPage() {
  const [allPlayers, setAllPlayers] = useState<Player[]>([]);
  const [teams, setTeams] = useState<Team[]>([
    { id: 0, name: 'You', isHuman: true, roster: [] },
    ...AI_TEAMS.map((t, i) => ({ id: i + 1, name: t.name, isHuman: false, roster: [] })),
  ]);
  const [pickNumber, setPickNumber] = useState(1);
  const draftComplete = pickNumber > TOTAL_PICKS;
  const [posFilter, setPosFilter] = useState<PosFilter>('All');
  const [searchTerm, setSearchTerm] = useState('');
  const [aiAdvice, setAiAdvice] = useState<string>('');
  const [adviceLoading, setAdviceLoading] = useState(false);
  const [loadingPlayers, setLoadingPlayers] = useState(true);
  const [aiProcessing, setAiProcessing] = useState(false);
  // null = show my roster; a team id = show that opponent's roster in the panel
  const [viewingTeamId, setViewingTeamId] = useState<number | null>(null);
  const [mockQueue, setMockQueue] = useState<Player[]>([]);
  // 'player' = no controls; 'commissioner' = real-time pick-timer controls
  const [role, setRole] = useState<'player' | 'commissioner'>('player');
  // Demo default is 90s — enough time to actually use the AI advisor before the clock
  // runs out; commissioner controls can drop it to 30s to show off the auto-pick flow.
  // null = unlimited
  const [pickTimerSeconds, setPickTimerSeconds] = useState<number | null>(90);
  const [timeRemaining, setTimeRemaining] = useState<number | null>(pickTimerSeconds);
  const [autoPickBanner, setAutoPickBanner] = useState<string | null>(null);

  function addToQueue(player: Player) {
    setMockQueue((prev) => prev.find((p) => p.id === player.id) ? prev : [...prev, player]);
  }
  function removeFromQueue(playerId: string) {
    setMockQueue((prev) => prev.filter((p) => p.id !== playerId));
  }
  function moveInQueue(fromIdx: number, toIdx: number) {
    setMockQueue((prev) => {
      const next = [...prev];
      const [item] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, item);
      return next;
    });
  }

  const draftedIds = useMemo(() => new Set(teams.flatMap((t) => t.roster.map((r) => r.player.id))), [teams]);
  const available = useMemo(() => allPlayers.filter((p) => !draftedIds.has(p.id)), [allPlayers, draftedIds]);

  const activeTeamIdx = draftComplete ? -1 : getActiveTeamIndex(pickNumber);
  const isHumanTurn = teams[activeTeamIdx]?.isHuman === true;
  const humanTeam = teams.find((t) => t.isHuman);
  const viewingTeam = viewingTeamId !== null ? teams.find((t) => t.id === viewingTeamId) ?? null : null;

  // Unfilled starter counts for the Need badge
  const unfilledStarterCounts = useMemo(() => {
    if (!humanTeam) return {} as Record<string, number>;
    const counts: Record<string, number> = {};
    for (const slot of SLOT_SEQUENCE) {
      if (!slot.bench && !humanTeam.roster.find((r) => r.slot_key === slot.key)) {
        counts[slot.pos!] = (counts[slot.pos!] ?? 0) + 1;
      }
    }
    return counts;
  }, [humanTeam]);

  const startersComplete = Object.keys(unfilledStarterCounts).length === 0;
  const needLabel = Object.entries(unfilledStarterCounts).map(([pos, count]) => `${count}${pos}`).join(', ');

  // Top available queued player for auto-suggest highlight
  const topQueued = useMemo(
    () => (isHumanTurn ? mockQueue.find((p) => !draftedIds.has(p.id)) ?? null : null),
    [mockQueue, draftedIds, isHumanTurn]
  );

  // Flat player list (All/G/F/C)
  const filteredFlat = useMemo(() => {
    if (posFilter === 'Teams') return [];
    return available.filter((p) => {
      const matchesPos = posFilter === 'All' || p.position === posFilter;
      const matchesSearch = !searchTerm ||
        p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        p.team_name.toLowerCase().includes(searchTerm.toLowerCase());
      return matchesPos && matchesSearch;
    });
  }, [available, posFilter, searchTerm]);

  // Grouped by team for Teams tab
  const teamGroups = useMemo(() => {
    if (posFilter !== 'Teams') return null;
    const filtered = available.filter((p) =>
      !searchTerm ||
      p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.team_name.toLowerCase().includes(searchTerm.toLowerCase())
    );
    const byTeam: Record<string, Player[]> = {};
    for (const p of filtered) {
      const key = `${String(p.team_seed).padStart(2, '0')}-${p.team_name}`;
      byTeam[key] = byTeam[key] ?? [];
      byTeam[key].push(p);
    }
    return Object.entries(byTeam)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, players]) => ({
        seed: players[0].team_seed,
        name: players[0].team_name,
        players: [...players].sort((a, b) => b.avg_ppg - a.avg_ppg),
      }));
  }, [available, posFilter, searchTerm]);

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

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) supabase.auth.signInAnonymously().then(({ data: anonData }) => {
        if (anonData.user) {
          fetch('/api/demo/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: anonData.user.id }) }).catch(() => {});
        }
      });
    });
  }, []);

  const submitPick = useCallback((player: Player) => {
    setTeams((prev) => prev.map((t) => {
      if (t.id !== prev[activeTeamIdx]?.id) return t;
      // Human picks fill the position-appropriate slot; AI picks fill sequentially
      const slot = t.isHuman ? getSlotForPlayer(t, player) : getNextSlotSequential(t);
      if (!slot) return t;
      return { ...t, roster: [...t.roster, { slot_key: slot.key, slot_position: player.position, is_bench: slot.bench, player }] };
    }));
    setPickNumber((n) => n + 1);
    setAiAdvice('');
    setMockQueue((prev) => prev.filter((q) => q.id !== player.id));
  }, [activeTeamIdx]);

  useEffect(() => {
    if (draftComplete || isHumanTurn || loadingPlayers || teams.length === 0) return;
    if (pickNumber > TOTAL_PICKS) return;
    // Defer setAiProcessing(true) to next tick so it's not a synchronous setState call
    // in the effect body — React batches it into the next render before the 800ms pick fires.
    const loadingTimer = setTimeout(() => setAiProcessing(true), 0);
    const pickTimer = setTimeout(() => {
      const team = teams[getActiveTeamIndex(pickNumber)];
      const avail = allPlayers.filter((p) => !new Set(teams.flatMap((t) => t.roster.map((r) => r.player.id))).has(p.id));
      const pick = aiPickPlayer(team, avail);
      if (pick) submitPick(pick);
      setAiProcessing(false);
    }, 800);
    return () => { clearTimeout(loadingTimer); clearTimeout(pickTimer); };
  }, [pickNumber, isHumanTurn, draftComplete, teams, allPlayers, loadingPlayers, submitPick]);

  // "Latest value" ref so the per-turn interval (below) always sees current state
  // without needing to be recreated when these change mid-turn.
  const autoPickContextRef = useRef({ humanTeam, available, mockQueue, draftedIds });
  useEffect(() => {
    autoPickContextRef.current = { humanTeam, available, mockQueue, draftedIds };
  });

  // Countdown — only runs on the human's turn. A fresh interval is created whenever
  // the turn changes (pickNumber) or the commissioner adjusts the timer length in
  // real time. `remaining`/`fired` are plain closure variables (not React state), so
  // the auto-pick fires exactly once per interval lifecycle:
  // - setInterval callbacks aren't double-invoked by StrictMode the way functional
  //   setState updaters are, so calling submitPick() here (a side effect) can't run twice
  //   the way it would inside a `setTimeRemaining(prev => ...)` updater.
  // - Driving the decision off the interval's own `remaining` counter (rather than a
  //   separate effect watching `timeRemaining === 0`) avoids re-firing when the human
  //   has back-to-back picks at a snake-draft turnaround — submitPick's state updates
  //   change this effect's deps (pickNumber) and recreate the interval for the new turn,
  //   but the OLD interval's closure already has `fired = true` and is cleared.
  // Reset the displayed countdown whenever the turn or timer setting changes.
  // "setState during render" pattern (React docs): when prevResetKey differs from the
  // computed key, call setState now so React re-renders with the new value in the same
  // pass — no effect, no extra paint, no eslint-set-state-in-effect violation.
  const timerResetKey = `${pickNumber}-${String(isHumanTurn)}-${String(draftComplete)}-${String(pickTimerSeconds)}`;
  const [prevTimerResetKey, setPrevTimerResetKey] = useState(timerResetKey);
  if (timerResetKey !== prevTimerResetKey) {
    setPrevTimerResetKey(timerResetKey);
    setTimeRemaining(pickTimerSeconds);
  }

  // Countdown interval — only ticks on the human's turn with a finite timer.
  // `remaining`/`fired` are closure vars so the auto-pick fires exactly once per
  // interval lifecycle, even if this effect re-runs (old interval has `fired = true`).
  useEffect(() => {
    if (draftComplete || !isHumanTurn || pickTimerSeconds === null) return;
    let remaining = pickTimerSeconds;
    let fired = false;
    const interval = setInterval(() => {
      remaining -= 1;
      setTimeRemaining(Math.max(remaining, 0));
      if (remaining <= 0 && !fired) {
        fired = true;
        clearInterval(interval);
        const { humanTeam, available, mockQueue, draftedIds } = autoPickContextRef.current;
        if (humanTeam) {
          const pick = getAutoPickForHuman(humanTeam, available, mockQueue, draftedIds);
          if (pick) {
            const reason = mockQueue.some((q) => q.id === pick.id) ? 'from your queue' : `${pick.position} · ${pick.avg_ppg} PPG`;
            setAutoPickBanner(`Time's up — auto-drafted ${pick.name} (${reason})`);
            submitPick(pick);
          }
        }
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [pickNumber, isHumanTurn, draftComplete, pickTimerSeconds, submitPick]);

  // Auto-dismiss the auto-pick banner
  useEffect(() => {
    if (!autoPickBanner) return;
    const timer = setTimeout(() => setAutoPickBanner(null), 6000);
    return () => clearTimeout(timer);
  }, [autoPickBanner]);

  async function getAIAdvice() {
    if (!humanTeam) return;
    setAdviceLoading(true);
    const unfilled_starters = SLOT_SEQUENCE.filter((s) => !s.bench && !humanTeam.roster.find((r) => r.slot_key === s.key)).map((s) => s.pos as string);
    const unfilled_bench = SLOT_SEQUENCE.filter((s) => s.bench && !humanTeam.roster.find((r) => r.slot_key === s.key)).length;
    const nextSlot = getSlotForPlayer(humanTeam, { position: unfilled_starters[0] ?? 'G' } as Player);
    const body = {
      available_players: available.slice(0, 50).map((p) => ({ id: p.id, name: p.name, position: p.position, avg_ppg: p.avg_ppg, team_name: p.team_name, team_seed: p.team_seed })),
      my_roster: humanTeam.roster.map((r) => ({ slot_key: r.slot_key, slot_position: r.slot_position, is_bench: r.is_bench, player_name: r.player.name, avg_ppg: r.player.avg_ppg, team_name: r.player.team_name, team_seed: r.player.team_seed })),
      pick_number: pickNumber,
      total_teams: N_TEAMS,
      unfilled_starters: [...new Set(unfilled_starters)].map((pos) => `${unfilled_starters.filter((p) => p === pos).length}× ${pos}`),
      unfilled_bench,
      question: nextSlot ? `I need a ${nextSlot.bench ? 'bench' : 'starter'} ${nextSlot.pos ?? 'player'}. Who should I pick?` : undefined,
    };
    try {
      const res = await fetch('/api/ai/mock-draft-advisor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      setAiAdvice(data.advice ?? data.error ?? 'No advice available.');
    } catch {
      setAiAdvice('Could not fetch advice — try again.');
    } finally {
      setAdviceLoading(false);
    }
  }

  const round = Math.ceil(pickNumber / N_TEAMS);
  const activeTeam = teams[activeTeamIdx];

  function PlayerRow({ p }: { p: Player }) {
    const canDraft = isHumanTurn && humanTeam != null && getSlotForPlayer(humanTeam, p) !== null;
    const isQueued = mockQueue.some((q) => q.id === p.id);
    const isTopSuggested = topQueued?.id === p.id;
    return (
      <div className={`flex items-center justify-between px-4 py-2.5 hover:bg-[#111] ${isTopSuggested ? 'border-l-2 border-yellow-400 bg-yellow-400/5' : ''}`}>
        <div className="flex min-w-0 items-center gap-3">
          <span className="w-5 shrink-0 text-center text-xs font-medium text-neutral-500">{p.position}</span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-white">
              {p.name}
              {isTopSuggested && <span className="ml-1.5 rounded bg-yellow-400/20 px-1 py-0.5 text-[10px] font-bold text-yellow-400">top queue</span>}
            </p>
            <p className="text-xs text-neutral-500">{p.team_name} #{p.team_seed} · {p.avg_ppg} PPG</p>
          </div>
        </div>
        <div className="ml-3 flex shrink-0 items-center gap-1">
          {!isQueued ? (
            <button
              onClick={() => addToQueue(p)}
              className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-500 hover:border-yellow-400/50 hover:text-yellow-400"
            >
              + Queue
            </button>
          ) : (
            <span className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-700">queued</span>
          )}
          {isHumanTurn && (
            <button
              onClick={() => canDraft && submitPick(p)}
              disabled={!canDraft}
              className={`rounded px-2.5 py-1 text-xs font-bold ${canDraft ? 'bg-yellow-400 text-black hover:bg-yellow-300' : 'cursor-not-allowed bg-neutral-800 text-neutral-600'}`}
            >
              {canDraft ? 'Draft' : 'Locked'}
            </button>
          )}
        </div>
      </div>
    );
  }

  // Roster panel — shows either your roster or an opponent's
  function RosterPanel() {
    const displayTeam = viewingTeam ?? humanTeam;
    const isOpponent = viewingTeam !== null;
    const title = isOpponent ? `${viewingTeam!.name}'s Roster` : 'Your Roster';

    return (
      <div className="rounded-lg border border-neutral-800 bg-[#0d0d0d]">
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-white">{title}</h2>
          {isOpponent && (
            <button onClick={() => setViewingTeamId(null)} className="text-[10px] text-neutral-500 hover:text-yellow-400">
              ← mine
            </button>
          )}
        </div>
        <div className="space-y-1 p-3">
          {SLOT_SEQUENCE.map((slot) => {
            const filled = displayTeam?.roster.find((r) => r.slot_key === slot.key);
            const label = slot.label;
            return (
              <div
                key={slot.key}
                className={`flex items-center gap-2 rounded px-2.5 py-2 text-xs ${filled ? 'bg-neutral-900' : 'border border-dashed border-neutral-800'}`}
              >
                <span className="w-24 shrink-0 text-[10px] font-bold uppercase tracking-wide text-neutral-500">{label}</span>
                {filled ? (
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-white">{filled.player.name}</p>
                    <p className="text-neutral-500">{filled.player.team_name} #{filled.player.team_seed} · {filled.player.avg_ppg} PPG</p>
                  </div>
                ) : (
                  <span className="text-neutral-700">—</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="border-b border-neutral-800 bg-[#080808] px-4 py-4">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <Link href="/">
            <span className="text-xs font-bold uppercase tracking-widest text-yellow-400">Mock Draft</span>
            <h1 className="mt-0.5 text-lg font-black uppercase tracking-tight text-white hover:text-neutral-300">March Madness Fantasy 2026</h1>
          </Link>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 rounded-full border border-neutral-800 bg-neutral-900 p-1">
              {(['player', 'commissioner'] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setRole(r)}
                  className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide transition-colors ${
                    role === r ? 'bg-yellow-400 text-black' : 'text-neutral-500 hover:text-white'
                  }`}
                >
                  {r === 'player' ? 'Player' : 'Commissioner'}
                </button>
              ))}
            </div>
            <Link href="/demo/league" className="text-sm text-yellow-400 hover:text-yellow-300">View Demo Standings →</Link>
          </div>
        </div>
      </div>

      {loadingPlayers ? (
        <div className="flex min-h-96 items-center justify-center"><p className="text-neutral-500">Loading players…</p></div>
      ) : draftComplete ? (
        <DraftComplete teams={teams} />
      ) : (
        <div className="mx-auto max-w-7xl px-4 py-6">
          {/* Status bar */}
          <div className="mb-4 flex items-center justify-between rounded-lg border border-neutral-800 bg-[#0d0d0d] px-4 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-neutral-400">Pick {pickNumber}/{TOTAL_PICKS}</span>
              <span className="text-sm text-neutral-400">Round {round}</span>
              <span className={`text-sm font-bold ${isHumanTurn ? 'text-yellow-400' : 'text-neutral-400'}`}>
                {aiProcessing ? `${activeTeam?.name} picking…` : isHumanTurn ? 'Your turn' : `${activeTeam?.name}'s turn`}
              </span>
              {isHumanTurn && !startersComplete && (
                <span className="rounded border border-yellow-400/30 bg-yellow-400/10 px-2 py-0.5 text-xs font-bold text-yellow-400">
                  Need: {needLabel}
                </span>
              )}
              {isHumanTurn && startersComplete && (
                <span className="rounded border border-green-400/30 bg-green-400/10 px-2 py-0.5 text-xs font-bold text-green-400">
                  Open
                </span>
              )}
              {isHumanTurn && pickTimerSeconds !== null && (
                <span className={`rounded border px-2 py-0.5 text-xs font-bold tabular-nums ${
                  timeRemaining !== null && timeRemaining <= 10
                    ? 'border-red-400/40 bg-red-400/10 text-red-400'
                    : 'border-neutral-700 bg-neutral-900 text-neutral-300'
                }`}>
                  ⏱ {timeRemaining ?? pickTimerSeconds}s
                </span>
              )}
            </div>
            {/* Turn strip — click AI names to view their roster */}
            <div className="hidden items-center gap-1 sm:flex">
              {teams.map((t, i) => (
                <button
                  key={t.id}
                  onClick={() => t.isHuman ? setViewingTeamId(null) : setViewingTeamId(viewingTeamId === t.id ? null : t.id)}
                  title={t.isHuman ? 'Your roster' : `View ${t.name}'s picks`}
                  className={`rounded px-2 py-1 text-xs font-bold uppercase tracking-wide transition-colors ${
                    i === activeTeamIdx
                      ? t.isHuman ? 'bg-yellow-400 text-black' : 'bg-neutral-200 text-black'
                      : 'bg-neutral-900 text-neutral-500 hover:bg-neutral-700 hover:text-white'
                  } ${viewingTeamId === t.id ? 'ring-1 ring-yellow-400' : ''}`}
                >
                  {t.isHuman ? 'You' : t.name}
                </button>
              ))}
            </div>
          </div>

          {/* Commissioner controls — real-time pick timer */}
          {role === 'commissioner' && (
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-yellow-400/20 bg-yellow-400/5 px-4 py-3">
              <span className="text-xs font-bold uppercase tracking-wide text-yellow-400">Commissioner Controls</span>
              <label className="flex items-center gap-2 text-xs text-neutral-400">
                Pick timer:
                <select
                  value={pickTimerSeconds === null ? 'off' : pickTimerSeconds}
                  onChange={(e) => setPickTimerSeconds(e.target.value === 'off' ? null : Number(e.target.value))}
                  className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-white focus:border-yellow-400/50 focus:outline-none"
                >
                  {TIMER_OPTIONS.map((opt) => (
                    <option key={opt.label} value={opt.value === null ? 'off' : opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>
              {isHumanTurn && pickTimerSeconds !== null && (
                <button
                  onClick={() => setTimeRemaining((t) => (t ?? 0) + 30)}
                  className="rounded border border-neutral-700 px-2.5 py-1 text-xs font-bold text-neutral-300 hover:border-yellow-400/50 hover:text-yellow-400"
                >
                  +30s
                </button>
              )}
              <span className="text-[10px] text-neutral-600">Changes apply in real time — affects your own pick clock for this demo.</span>
            </div>
          )}

          {/* Auto-pick banner */}
          {autoPickBanner && (
            <div className="mb-4 rounded-lg border border-yellow-400/30 bg-yellow-400/10 px-4 py-2.5 text-sm font-semibold text-yellow-300">
              ⏱ {autoPickBanner}
            </div>
          )}

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-4">
            {/* Player pool */}
            <div className="lg:col-span-2">
              <div className="rounded-lg border border-neutral-800 bg-[#0d0d0d]">
                <div className="space-y-2 border-b border-neutral-800 px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-sm font-bold uppercase tracking-wide text-white">Available Players</h2>
                    <div className="flex gap-1">
                      {(['All', 'G', 'F', 'C', 'Teams'] as PosFilter[]).map((pos) => (
                        <button key={pos} onClick={() => setPosFilter(pos)}
                          className={`rounded px-2.5 py-1 text-xs font-bold uppercase tracking-wide transition-colors ${posFilter === pos ? 'bg-yellow-400 text-black' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'}`}>
                          {pos}
                        </button>
                      ))}
                    </div>
                  </div>
                  <input type="text" placeholder="Search player or team…" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-yellow-400/50 focus:outline-none" />
                  {isHumanTurn && (
                    <div>
                      <button onClick={getAIAdvice} disabled={adviceLoading}
                        className="rounded border border-yellow-400/30 bg-yellow-400/10 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-yellow-400 hover:bg-yellow-400/20 disabled:opacity-50">
                        {adviceLoading ? '✦ Thinking…' : '✦ Ask AI Advisor'}
                      </button>
                      {aiAdvice && (
                        <div className="mt-2 rounded border border-yellow-400/20 bg-yellow-400/5 px-3 py-2">
                          <p className="text-xs text-yellow-200">{aiAdvice}</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="max-h-[420px] overflow-y-auto divide-y divide-neutral-800/50">
                  {posFilter === 'Teams' && teamGroups ? (
                    teamGroups.length === 0 ? <p className="px-4 py-6 text-center text-sm text-neutral-500">No players match.</p> : (
                      teamGroups.map((group) => (
                        <div key={`${group.seed}-${group.name}`}>
                          <div className="sticky top-0 bg-neutral-900 px-4 py-1.5">
                            <span className="text-xs font-bold uppercase tracking-wide text-yellow-400">#{group.seed} {group.name}</span>
                          </div>
                          {group.players.map((p) => <PlayerRow key={p.id} p={p} />)}
                        </div>
                      ))
                    )
                  ) : (
                    filteredFlat.length === 0 ? <p className="px-4 py-6 text-center text-sm text-neutral-500">No players match.</p> :
                      filteredFlat.slice(0, 80).map((p) => <PlayerRow key={p.id} p={p} />)
                  )}
                </div>
              </div>
            </div>

            {/* My Queue — hidden when viewing an opponent */}
            {!viewingTeam && (
              <div>
                <div className="rounded-lg border border-neutral-800 bg-[#0d0d0d]">
                  <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
                    <div>
                      <h2 className="text-sm font-bold uppercase tracking-wide text-white">My Queue</h2>
                      <p className="mt-0.5 text-xs text-neutral-600">
                        {mockQueue.length === 0
                          ? 'Click "+ Queue" on any player to add'
                          : `${mockQueue.filter((p) => !draftedIds.has(p.id)).length} available · drag to reorder`}
                      </p>
                    </div>
                  </div>
                  <div className="p-3">
                    {mockQueue.length === 0 ? (
                      <div className="rounded border border-dashed border-neutral-800 px-3 py-5 text-center">
                        <p className="text-xs text-neutral-600">Queue is empty.</p>
                        <p className="mt-1 text-[10px] text-neutral-700">Add players while browsing — your top available pick is highlighted when it&apos;s your turn.</p>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {mockQueue.map((p, idx) => {
                          const drafted = draftedIds.has(p.id);
                          const isTop = !drafted && idx === mockQueue.findIndex((q) => !draftedIds.has(q.id));
                          const canDraft = !drafted && isHumanTurn && humanTeam != null && getSlotForPlayer(humanTeam, p) !== null;
                          return (
                            <div
                              key={p.id}
                              draggable={!drafted}
                              onDragStart={(e) => e.dataTransfer.setData('queueIdx', String(idx))}
                              onDragOver={(e) => e.preventDefault()}
                              onDrop={(e) => { const from = parseInt(e.dataTransfer.getData('queueIdx')); if (!isNaN(from) && from !== idx) moveInQueue(from, idx); }}
                              className={`flex cursor-grab items-center gap-2 rounded px-2.5 py-2 text-xs active:cursor-grabbing ${drafted ? 'opacity-35' : isTop && isHumanTurn ? 'border border-yellow-400/30 bg-yellow-400/10' : 'bg-neutral-900'}`}
                            >
                              <span className="w-4 shrink-0 text-center font-bold text-neutral-600">{idx + 1}</span>
                              <div className="min-w-0 flex-1">
                                <p className="truncate font-medium text-white">{p.name} <span className="text-neutral-500">{p.position}</span></p>
                                <p className="text-neutral-500">{p.team_name} #{p.team_seed}</p>
                              </div>
                              {drafted ? (
                                <span className="shrink-0 text-[10px] text-neutral-700">picked</span>
                              ) : (
                                <>
                                  {canDraft && (
                                    <button
                                      onClick={() => submitPick(p)}
                                      className="shrink-0 rounded bg-yellow-400 px-2 py-1 text-[10px] font-bold text-black hover:bg-yellow-300"
                                    >
                                      Draft
                                    </button>
                                  )}
                                  <button onClick={() => removeFromQueue(p.id)} className="shrink-0 text-neutral-600 hover:text-red-400">✕</button>
                                </>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Roster panel — shows your roster OR opponent's */}
            <div className={viewingTeam ? 'lg:col-span-1' : ''}>
              {RosterPanel()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DraftComplete({ teams }: { teams: Team[] }) {
  const [phase, setPhase] = useState<'review' | 'lineup' | 'sim'>('review');
  const [finalTeams, setFinalTeams] = useState<Team[] | null>(null);
  const humanTeam = teams.find((t) => t.isHuman)!;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 text-center">
        <p className="text-xs font-bold uppercase tracking-widest text-yellow-400">Draft Complete</p>
        <h2 className="mt-1 text-3xl font-black uppercase text-white">Final Rosters</h2>
      </div>

      <div className="space-y-3">
        {teams.map((t) => (
          <div key={t.id} className={`overflow-hidden rounded-lg border bg-[#0d0d0d] ${t.isHuman ? 'border-yellow-400/30' : 'border-neutral-800'}`}>
            <div className="border-b border-neutral-800 px-4 py-2.5">
              <span className={`text-sm font-bold uppercase tracking-wide ${t.isHuman ? 'text-yellow-400' : 'text-neutral-300'}`}>
                {t.isHuman ? `${t.name} (You)` : t.name}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-4">
              {t.roster.map((r) => (
                <div key={r.slot_key} className={`rounded p-2.5 ${t.isHuman ? 'border border-yellow-400/20 bg-yellow-400/10' : 'bg-neutral-900'}`}>
                  <p className={`text-[10px] font-bold uppercase tracking-wide ${t.isHuman ? 'text-yellow-400' : 'text-neutral-500'}`}>
                    {SLOT_SEQUENCE.find((s) => s.key === r.slot_key)?.label}
                  </p>
                  <p className="mt-0.5 truncate text-sm font-bold text-white">{r.player.name}</p>
                  <p className="text-xs text-neutral-400">{r.player.team_name} #{r.player.team_seed}</p>
                  <p className="text-xs text-neutral-500">{r.player.avg_ppg} PPG</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {phase === 'review' && (
        <div className="mt-6 text-center">
          <button
            onClick={() => setPhase('lineup')}
            className="rounded border border-yellow-400/40 px-4 py-2 text-sm font-bold uppercase tracking-wide text-yellow-400 hover:bg-yellow-400/10"
          >
            Set Your Lineup →
          </button>
        </div>
      )}

      {phase === 'lineup' && (
        <LineupEditor
          team={humanTeam}
          onConfirm={(roster) => {
            setFinalTeams(teams.map((t) => (t.isHuman ? { ...t, roster } : t)));
            setPhase('sim');
          }}
        />
      )}

      {phase === 'sim' && finalTeams && <SeasonSimulator teams={finalTeams} />}

      <div className="mt-8 rounded-lg border border-yellow-400/30 bg-yellow-400/5 p-6 text-center">
        <p className="font-black uppercase tracking-wide text-yellow-400">Like what you drafted?</p>
        <p className="mt-1 text-sm text-neutral-400">Create a real league and draft against friends before March Madness starts.</p>
        <div className="mt-4 flex justify-center gap-3">
          <Link href="/auth/signup" className="rounded bg-yellow-400 px-4 py-2 text-sm font-black uppercase tracking-wide text-black hover:bg-yellow-300">Create account</Link>
          <Link href="/demo/league" className="rounded border border-neutral-700 bg-transparent px-4 py-2 text-sm font-bold uppercase tracking-wide text-neutral-300 hover:bg-neutral-900">View demo league</Link>
        </div>
      </div>
    </div>
  );
}

// ── Lineup Editor ───────────────────────────────────────────────────────
// One last chance to reorder your starting five before the season plays out.
// E.g. start a likely one-and-done bench superstar to bank their game-1
// points, then let a deep-tournament #1 seed take that slot automatically
// once their team gets knocked out (same position-matched swap the real
// bench-order feature does — just done up front here instead of mid-season).
function LineupEditor({ team, onConfirm }: { team: Team; onConfirm: (roster: RosterSlot[]) => void }) {
  const [roster, setRoster] = useState<RosterSlot[]>(team.roster);
  const starterSlots = SLOT_SEQUENCE.filter((s) => !s.bench);
  const benchSlots = SLOT_SEQUENCE.filter((s) => s.bench);

  function swap(starterKey: string, benchKey: string) {
    setRoster((prev) => {
      const next = prev.map((r) => ({ ...r }));
      const starterEntry = next.find((r) => r.slot_key === starterKey);
      const benchEntry = next.find((r) => r.slot_key === benchKey);
      if (!starterEntry || !benchEntry) return prev;
      const tmp = starterEntry.player;
      starterEntry.player = benchEntry.player;
      benchEntry.player = tmp;
      return next;
    });
  }

  return (
    <div className="mt-6 rounded-lg border border-yellow-400/30 bg-[#0d0d0d] p-5">
      <p className="text-xs font-bold uppercase tracking-widest text-yellow-400">Set Your Lineup</p>
      <h3 className="mt-1 text-lg font-black uppercase text-white">Last Chance Before the Season Starts</h3>
      <p className="mt-1 text-xs text-neutral-500">
        Swap a bench player into your starting five if you think they&apos;ll only last a round or two — you&apos;ll
        bank their points now, and whoever they replace slides to the bench to activate later if your starter&apos;s
        team goes out.
      </p>

      <div className="mt-4 space-y-2">
        {starterSlots.map((slot) => {
          const entry = roster.find((r) => r.slot_key === slot.key);
          const eligibleBench = benchSlots
            .map((b) => roster.find((r) => r.slot_key === b.key))
            .filter((b): b is RosterSlot => b != null && b.player.position === slot.pos);
          return (
            <div key={slot.key} className="flex flex-wrap items-center gap-2 rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs">
              <span className="w-20 shrink-0 font-bold uppercase tracking-wide text-neutral-500">{slot.label}</span>
              <span className="min-w-0 flex-1 truncate text-white">
                {entry?.player.name} <span className="text-neutral-500">· {entry?.player.team_name} #{entry?.player.team_seed} · {entry?.player.avg_ppg} PPG</span>
              </span>
              {eligibleBench.length > 0 && (
                <select
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) swap(slot.key, e.target.value);
                    e.target.value = '';
                  }}
                  className="shrink-0 rounded border border-neutral-700 bg-black px-2 py-1 text-xs text-neutral-300 focus:border-yellow-400/50 focus:outline-none"
                >
                  <option value="">Swap in from bench…</option>
                  {eligibleBench.map((b) => (
                    <option key={b.slot_key} value={b.slot_key}>
                      {b.player.name} ({b.player.team_name} #{b.player.team_seed}, {b.player.avg_ppg} PPG)
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-3 text-[10px] font-bold uppercase tracking-wide text-neutral-600">Bench</p>
      <p className="mt-1 text-xs text-neutral-500">
        {benchSlots.map((b) => roster.find((r) => r.slot_key === b.key)?.player.name).join(' · ')}
      </p>

      <div className="mt-4 text-center">
        <button
          onClick={() => onConfirm(roster)}
          className="rounded bg-yellow-400 px-4 py-2 text-sm font-black uppercase tracking-wide text-black hover:bg-yellow-300"
        >
          Confirm Lineup — Simulate the Season →
        </button>
      </div>
    </div>
  );
}

// ── Season Simulator ────────────────────────────────────────────────────
// Mock post-draft scoring walkthrough (client-side only, no DB writes).
// A real single-elimination bracket (src/lib/utils/bracketSim.ts) drives which
// teams survive each round; fantasy scoring and the bracket visual both read
// off that one source of truth. Roster bookkeeping mirrors the real
// roster_slots model (see RosterActivationService): each player's stint in a
// slot is its own "assignment" with an acquired/released round, so the exact
// same getRoundCell()/RoundCellBadge used on the leaderboard and roster pages
// works here unchanged.

const SCORING_ROUNDS: { stage: RoundStage; label: string; short: string }[] = [
  { stage: 'r64', label: 'Round of 64', short: 'R64' },
  { stage: 'r32', label: 'Round of 32', short: 'R32' },
  { stage: 's16', label: 'Sweet 16', short: 'S16' },
  { stage: 'e8', label: 'Elite 8', short: 'E8' },
  { stage: 'f4', label: 'Final Four', short: 'F4' },
  { stage: 'championship', label: 'Championship', short: 'CHAMP' },
];

// Real box-score points are always whole numbers (2pt/3pt field goals, 1pt free throws).
function rollScore(avgPpg: number): number {
  return Math.round(avgPpg * (0.6 + Math.random() * 0.8));
}

function requiredPosForSlot(slot_key: string): 'G' | 'F' | 'C' | null {
  return SLOT_SEQUENCE.find((s) => s.key === slot_key)?.pos ?? null;
}

function stageForRoundIdx(idx: number | null): RoundStage | null {
  if (idx === null) return null;
  return SCORING_ROUNDS[idx]?.stage ?? null;
}

// One player's stint in one physical slot — mirrors a roster_slots row.
// A promotion ends the bench stint (releasedIdx set, reason 'promoted_out')
// and opens a brand new assignment for the same slot_key with the promoted
// player, exactly like RosterActivationService creating a new row instead of
// mutating the old one.
interface SimAssignment {
  key: string;
  slot_key: string;
  is_bench: boolean;
  player: Player;
  acquiredIdx: number;
  releasedIdx: number | null;
  releaseReason: 'eliminated' | 'promoted_out' | null;
  countedPts: Partial<Record<RoundStage, number>>;
  rawPts: Partial<Record<RoundStage, number>>;
}

interface SimTeam {
  id: number;
  name: string;
  isHuman: boolean;
  assignments: SimAssignment[];
}

interface RoundRecapPerTeam {
  team_name: string;
  isHuman: boolean;
  eliminatedPlayers: { name: string; team_name: string; team_seed: number }[];
  promotions: { in_player: string; out_player: string; slot_label: string }[];
}

interface RoundRecap {
  stage: RoundStage;
  label: string;
  eliminatedTeams: { team_name: string; team_seed: number }[];
  perTeam: RoundRecapPerTeam[];
  topPerformer: { team_name: string; isHuman: boolean; player_name: string; team_name_played: string; points: number } | null;
  leftOnBench: { team_name: string; isHuman: boolean; points: number; players: string[] } | null;
}

function buildInitialSimTeams(teams: Team[]): SimTeam[] {
  return teams.map((t) => ({
    id: t.id,
    name: t.name,
    isHuman: t.isHuman,
    assignments: t.roster.map((r) => ({
      key: `${r.slot_key}#0`,
      slot_key: r.slot_key,
      is_bench: r.is_bench,
      player: r.player,
      acquiredIdx: 0,
      releasedIdx: null,
      releaseReason: null,
      countedPts: {},
      rawPts: {},
    })),
  }));
}

// Pure: plays one fantasy scoring round given the bracket field that entered
// it and which teams lost. Returns updated teams plus a recap.
function simulateFantasyRound(
  teams: SimTeam[],
  fieldBefore: BracketTeam[],
  eliminatedNames: Set<string>,
  roundIdx: number,
): { teams: SimTeam[]; recap: RoundRecap } {
  const { stage, label } = SCORING_ROUNDS[roundIdx];
  const fieldNames = new Set(fieldBefore.map((t) => t.name));
  const perTeamRecap: RoundRecapPerTeam[] = [];
  let topPerformer: RoundRecap['topPerformer'] = null;
  const benchTotals = new Map<string, { isHuman: boolean; points: number; players: string[] }>();

  const nextTeams = teams.map((team) => {
    const assignments = team.assignments.map((a) => ({ ...a, countedPts: { ...a.countedPts }, rawPts: { ...a.rawPts } }));

    // 1. Roll a raw score for every still-ongoing assignment whose team played this round.
    for (const a of assignments) {
      if (a.releasedIdx !== null || !fieldNames.has(a.player.team_name)) continue;
      const pts = rollScore(a.player.avg_ppg);
      a.rawPts[stage] = pts;
      if (!a.is_bench) {
        a.countedPts[stage] = pts;
        if (topPerformer === null || pts > topPerformer.points) {
          topPerformer = { team_name: team.name, isHuman: team.isHuman, player_name: a.player.name, team_name_played: a.player.team_name, points: pts };
        }
      } else {
        const bucket = benchTotals.get(team.name) ?? { isHuman: team.isHuman, points: 0, players: [] };
        bucket.points += pts;
        bucket.players.push(a.player.name);
        benchTotals.set(team.name, bucket);
      }
    }

    // 2. Bench stints whose OWN team just went out end here too (never activated).
    for (const a of assignments) {
      if (a.releasedIdx !== null || !a.is_bench) continue;
      if (eliminatedNames.has(a.player.team_name)) {
        a.releasedIdx = roundIdx;
        a.releaseReason = 'eliminated';
      }
    }

    // 3. Starter stints whose team was eliminated end here; try to promote a
    // same-position bench player whose team is still alive.
    const promotions: RoundRecapPerTeam['promotions'] = [];
    for (const a of assignments) {
      if (a.releasedIdx !== null || a.is_bench) continue;
      if (!eliminatedNames.has(a.player.team_name)) continue;
      a.releasedIdx = roundIdx;
      a.releaseReason = 'eliminated';

      const requiredPos = requiredPosForSlot(a.slot_key);
      // A bench player can only be promoted if their own team is still alive
      // going into next round — no point activating someone whose team also
      // just lost.
      const candidates = assignments
        .filter(
          (b) =>
            b.is_bench &&
            b.releasedIdx === null &&
            b.player.position === requiredPos &&
            !eliminatedNames.has(b.player.team_name)
        )
        .sort((x, y) => y.player.avg_ppg - x.player.avg_ppg);

      if (candidates.length > 0) {
        const promoted = candidates[0];
        promoted.releasedIdx = roundIdx;
        promoted.releaseReason = 'promoted_out';
        const slotLabel = SLOT_SEQUENCE.find((s) => s.key === a.slot_key)?.label ?? a.slot_key;
        promotions.push({ in_player: promoted.player.name, out_player: a.player.name, slot_label: slotLabel });
        assignments.push({
          key: `${a.slot_key}#${roundIdx + 1}`,
          slot_key: a.slot_key,
          is_bench: false,
          player: promoted.player,
          acquiredIdx: roundIdx + 1,
          releasedIdx: null,
          releaseReason: null,
          countedPts: {},
          rawPts: {},
        });
      }
    }

    const eliminatedPlayers = assignments
      .filter((a) => a.releasedIdx === roundIdx && a.releaseReason === 'eliminated')
      .map((a) => ({ name: a.player.name, team_name: a.player.team_name, team_seed: a.player.team_seed }));

    if (eliminatedPlayers.length > 0 || promotions.length > 0) {
      perTeamRecap.push({ team_name: team.name, isHuman: team.isHuman, eliminatedPlayers, promotions });
    }

    return { ...team, assignments };
  });

  let leftOnBench: RoundRecap['leftOnBench'] = null;
  for (const [team_name, bucket] of benchTotals) {
    if (bucket.points > 0 && (!leftOnBench || bucket.points > leftOnBench.points)) {
      leftOnBench = { team_name, isHuman: bucket.isHuman, points: bucket.points, players: bucket.players };
    }
  }

  return {
    teams: nextTeams,
    recap: {
      stage,
      label,
      eliminatedTeams: [...eliminatedNames].map((name) => ({
        team_name: name,
        team_seed: fieldBefore.find((t) => t.name === name)?.seed ?? 0,
      })),
      perTeam: perTeamRecap,
      topPerformer,
      leftOnBench,
    },
  };
}

function SeasonSimulator({ teams }: { teams: Team[] }) {
  const [simTeams, setSimTeams] = useState<SimTeam[]>(() => buildInitialSimTeams(teams));
  const [roundsHistory, setRoundsHistory] = useState<BracketTeam[][]>([]);
  const [loadingBracket, setLoadingBracket] = useState(true);
  const [roundIdx, setRoundIdx] = useState(0);
  // Which round is currently being VIEWED — lets you scrub back through already-played
  // rounds without losing simulation progress. Always jumps to the latest round the
  // moment you actually simulate one (see the effect below), so "Simulate Next Round"
  // still feels immediate.
  const [viewRoundIdx, setViewRoundIdx] = useState(0);
  const [recaps, setRecaps] = useState<RoundRecap[]>([]);
  const [expandedTeamIds, setExpandedTeamIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    fetch('/api/teams')
      .then((r) => r.json())
      .then((data) => {
        const raw = (data.teams ?? []) as { name: string; seed: number; region: string }[];
        setRoundsHistory([buildInitialField(raw)]);
      })
      .finally(() => setLoadingBracket(false));
  }, []);

  // "setState during render" pattern (same technique used for the draft pick timer
  // above): whenever roundIdx moves forward (a round was actually simulated), snap the
  // view to it in the same render pass — no extra effect/paint needed.
  const [prevRoundIdxForView, setPrevRoundIdxForView] = useState(roundIdx);
  if (roundIdx !== prevRoundIdxForView) {
    setPrevRoundIdxForView(roundIdx);
    setViewRoundIdx(roundIdx);
  }

  const isComplete = roundIdx >= SCORING_ROUNDS.length;

  function toggleExpand(id: number) {
    setExpandedTeamIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function playOneRound(history: BracketTeam[][], curTeams: SimTeam[], idx: number): { history: BracketTeam[][]; teams: SimTeam[]; recap: RoundRecap } | null {
    const current = history[history.length - 1];
    if (!current || current.length <= 1) return null;
    const { winners, matchups } = simulateBracketRound(current);
    const eliminatedNames = new Set(matchups.map((m) => m.loser.name));
    const { teams: nextTeams, recap } = simulateFantasyRound(curTeams, current, eliminatedNames, idx);
    return { history: [...history, winners], teams: nextTeams, recap };
  }

  function advanceRound() {
    if (isComplete) return;
    const result = playOneRound(roundsHistory, simTeams, roundIdx);
    if (!result) return;
    setRoundsHistory(result.history);
    setSimTeams(result.teams);
    setRecaps((prev) => [...prev, result.recap]);
    setRoundIdx((n) => n + 1);
  }

  function autoComplete() {
    let curHistory = roundsHistory;
    let curTeams = simTeams;
    const newRecaps: RoundRecap[] = [];
    let i = roundIdx;
    for (; i < SCORING_ROUNDS.length; i++) {
      const result = playOneRound(curHistory, curTeams, i);
      if (!result) break;
      curHistory = result.history;
      curTeams = result.teams;
      newRecaps.push(result.recap);
    }
    setRoundsHistory(curHistory);
    setSimTeams(curTeams);
    setRecaps((prev) => [...prev, ...newRecaps]);
    setRoundIdx(i);
  }

  function reset() {
    setSimTeams(buildInitialSimTeams(teams));
    setRoundsHistory((prev) => (prev.length > 0 ? [prev[0]] : prev));
    setRecaps([]);
    setRoundIdx(0);
    setViewRoundIdx(0);
    setExpandedTeamIds(new Set());
  }

  // Totals/standings as of the round being VIEWED, not necessarily the latest simulated
  // round — this is what makes "step back through the season" actually show the
  // standings as they stood at that point instead of always the final numbers.
  const totals = simTeams
    .map((t) => {
      const perRound: Partial<Record<RoundStage, number>> = {};
      for (const r of SCORING_ROUNDS) {
        perRound[r.stage] = t.assignments.reduce((sum, a) => sum + (a.countedPts[r.stage] ?? 0), 0);
      }
      const total = SCORING_ROUNDS.slice(0, viewRoundIdx).reduce((sum, r) => sum + (perRound[r.stage] ?? 0), 0);
      return { id: t.id, name: t.name, isHuman: t.isHuman, total, perRound };
    })
    .sort((a, b) => b.total - a.total);

  const rosteredTeamNames = useMemo(() => {
    const s = new Set<string>();
    for (const t of simTeams) for (const a of t.assignments) s.add(a.player.team_name);
    return s;
  }, [simTeams]);

  const humanTeam = simTeams.find((t) => t.isHuman);

  // "As of the round being viewed" — not just the latest state — so scrubbing back
  // shows who was actually starting at that point in the season.
  function occupantAsOf(slot_key: string, asOfRoundIdx: number) {
    return (
      humanTeam?.assignments.find(
        (a) => a.slot_key === slot_key && a.acquiredIdx <= asOfRoundIdx && (a.releasedIdx === null || a.releasedIdx >= asOfRoundIdx)
      ) ?? null
    );
  }
  function lastEndedAsOf(slot_key: string, asOfRoundIdx: number) {
    return (
      [...(humanTeam?.assignments ?? [])]
        .filter((a) => a.slot_key === slot_key && a.releasedIdx !== null && a.releasedIdx < asOfRoundIdx)
        .sort((a, b) => (b.releasedIdx ?? -1) - (a.releasedIdx ?? -1))[0] ?? null
    );
  }

  return (
    <div className="mt-6 rounded-lg border border-neutral-800 bg-[#0d0d0d] p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-yellow-400">Season Simulator</p>
          <h3 className="text-lg font-black uppercase text-white">Watch the Scoring Logic Play Out</h3>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={advanceRound}
            disabled={isComplete || loadingBracket}
            className="rounded bg-yellow-400 px-3 py-1.5 text-xs font-bold uppercase text-black hover:bg-yellow-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Simulate Next Round →
          </button>
          <button
            onClick={autoComplete}
            disabled={isComplete || loadingBracket}
            className="rounded border border-neutral-700 px-3 py-1.5 text-xs font-bold uppercase text-neutral-300 hover:border-yellow-400/50 hover:text-yellow-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Auto-Complete Season
          </button>
          {roundIdx > 0 && (
            <button onClick={reset} className="rounded border border-neutral-800 px-3 py-1.5 text-xs font-bold uppercase text-neutral-500 hover:text-white">
              Reset
            </button>
          )}
        </div>
      </div>

      {/* Round stepper — click any already-simulated round to review it, or use the
          arrows. Viewing the past doesn't affect simulation progress. */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => setViewRoundIdx((v) => Math.max(0, v - 1))}
          disabled={viewRoundIdx <= 0}
          className="rounded border border-neutral-800 px-2 py-1 text-xs font-bold text-neutral-400 hover:border-yellow-400/50 hover:text-yellow-400 disabled:cursor-not-allowed disabled:opacity-30"
          aria-label="Previous round"
        >
          ◀
        </button>
        {SCORING_ROUNDS.map((r, i) => (
          <button
            key={r.stage}
            onClick={() => i <= roundIdx && setViewRoundIdx(i)}
            disabled={i > roundIdx}
            className={`rounded px-2 py-1 text-[10px] font-bold uppercase tracking-wide transition-colors ${
              i === viewRoundIdx
                ? 'border border-yellow-400 bg-yellow-400/20 text-yellow-400'
                : i < roundIdx
                  ? 'bg-yellow-400/10 text-yellow-500 hover:bg-yellow-400/20'
                  : i === roundIdx && !isComplete
                    ? 'border border-yellow-400/50 text-yellow-400'
                    : 'border border-neutral-800 text-neutral-600'
            }`}
          >
            {r.label}
          </button>
        ))}
        <button
          onClick={() => setViewRoundIdx((v) => Math.min(roundIdx, v + 1))}
          disabled={viewRoundIdx >= roundIdx}
          className="rounded border border-neutral-800 px-2 py-1 text-xs font-bold text-neutral-400 hover:border-yellow-400/50 hover:text-yellow-400 disabled:cursor-not-allowed disabled:opacity-30"
          aria-label="Next round"
        >
          ▶
        </button>
        {viewRoundIdx < roundIdx && (
          <button
            onClick={() => setViewRoundIdx(roundIdx)}
            className="rounded border border-yellow-400/30 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-yellow-400 hover:bg-yellow-400/10"
          >
            Jump to Latest
          </button>
        )}
      </div>
      {viewRoundIdx < roundIdx && (
        <p className="mb-3 text-[11px] text-neutral-500">
          Viewing standings as of {viewRoundIdx === 0 ? 'before the season started' : `after ${SCORING_ROUNDS[viewRoundIdx - 1].label}`} — {roundIdx - viewRoundIdx} more round{roundIdx - viewRoundIdx === 1 ? '' : 's'} already simulated ahead of here.
        </p>
      )}

      {/* Leaderboard — click a team name to see their full player-by-player breakdown */}
      <div className="mb-4 overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full text-left text-xs">
          <thead className="bg-neutral-900 text-[10px] uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">Team</th>
              {SCORING_ROUNDS.map((r) => (
                <th key={r.stage} className="px-2 py-2 text-right">{r.short}</th>
              ))}
              <th className="px-3 py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {totals.map((t, idx) => {
              const team = simTeams.find((st) => st.id === t.id)!;
              const expanded = expandedTeamIds.has(t.id);
              const sortedAssignments = [...team.assignments].sort(
                (a, b) => a.acquiredIdx - b.acquiredIdx || a.slot_key.localeCompare(b.slot_key)
              );
              return (
                <Fragment key={t.id}>
                  <tr className={`border-t border-neutral-800 ${t.isHuman ? 'bg-yellow-400/10' : ''}`}>
                    <td className="px-3 py-2 font-bold text-neutral-500">{idx + 1}</td>
                    <td className={`px-3 py-2 font-bold ${t.isHuman ? 'text-yellow-400' : 'text-white'}`}>
                      <button type="button" onClick={() => toggleExpand(t.id)} className="flex items-center gap-1.5 hover:underline">
                        <span className="w-2 shrink-0 text-[10px] text-neutral-500">{expanded ? '▼' : '▶'}</span>
                        {t.isHuman ? `${t.name} (You)` : t.name}
                      </button>
                    </td>
                    {SCORING_ROUNDS.map((r, i) => (
                      <td key={r.stage} className="px-2 py-2 text-right tabular-nums text-neutral-400">
                        {i < viewRoundIdx ? (t.perRound[r.stage] ?? 0) : '—'}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right font-bold tabular-nums text-white">{t.total}</td>
                  </tr>
                  {expanded && (
                    <tr className="border-t border-neutral-900 bg-black/40">
                      <td colSpan={SCORING_ROUNDS.length + 3} className="px-0 py-2">
                        <table className="w-full text-[11px]">
                          <thead>
                            <tr className="border-b border-neutral-800 text-neutral-500">
                              <th className="py-1.5 pl-8 pr-2 text-left font-bold">Player</th>
                              {SCORING_ROUNDS.map((r) => (
                                <th key={r.stage} className="px-2 py-1.5 text-right font-bold">{r.short}</th>
                              ))}
                              <th className="py-1.5 pl-2 pr-4 text-right font-bold">Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sortedAssignments.map((a) => {
                              const acquired_at_round_stage = stageForRoundIdx(a.acquiredIdx) ?? 'r64';
                              const released_at_round_stage = stageForRoundIdx(a.releasedIdx);
                              const rowTotal = SCORING_ROUNDS.slice(0, viewRoundIdx).reduce((s, r) => s + (a.countedPts[r.stage] ?? 0), 0);
                              return (
                                <tr key={a.key} className="border-b border-neutral-900 last:border-0">
                                  <td className="py-1.5 pl-8 pr-2">
                                    <span className={a.releasedIdx === null && !a.is_bench ? 'font-medium text-neutral-200' : 'font-medium text-neutral-500'}>
                                      {a.player.name}
                                    </span>
                                    <span className="ml-1 text-neutral-600">{a.player.team_name} #{a.player.team_seed}</span>
                                    {a.is_bench && <span className="ml-1.5 rounded bg-neutral-800 px-1 py-0.5 text-neutral-500">B</span>}
                                    {a.releaseReason === 'promoted_out' && (
                                      <span className="ml-1.5 rounded bg-yellow-400/10 px-1 py-0.5 text-yellow-500">promoted out</span>
                                    )}
                                  </td>
                                  {SCORING_ROUNDS.map((r, i) => {
                                    const cell = i < viewRoundIdx
                                      ? getRoundCell(r.stage, a.countedPts, a.rawPts, {
                                          is_bench: a.is_bench,
                                          acquired_at_round_stage,
                                          released_at_round_stage,
                                        })
                                      : null;
                                    return (
                                      <td key={r.stage} className="px-2 py-1.5 text-right tabular-nums">
                                        <RoundCellBadge cell={cell} />
                                      </td>
                                    );
                                  })}
                                  <td className="py-1.5 pl-2 pr-4 text-right font-medium tabular-nums text-neutral-400">
                                    {rowTotal}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Round recaps — eliminated teams, per-user roster impact, and a couple of fun stats.
          Sliced to the round being viewed so scrubbing back doesn't spoil later rounds. */}
      {recaps.length > 0 && (
        <div className="mb-4 max-h-64 space-y-3 overflow-y-auto rounded-lg border border-neutral-800 bg-black/40 p-3">
          {[...recaps.slice(0, viewRoundIdx)].reverse().map((recap) => (
            <div key={recap.stage} className="text-xs">
              <p className="font-bold uppercase tracking-wide text-neutral-300">{recap.label}</p>
              {recap.eliminatedTeams.length === 0 ? (
                <p className="text-neutral-600">No eliminations.</p>
              ) : (
                <p className="text-neutral-500">
                  ❌ Eliminated: {recap.eliminatedTeams.map((e) => `#${e.team_seed} ${e.team_name}`).join(', ')}
                </p>
              )}
              {recap.perTeam.map((pt) => (
                <p key={pt.team_name} className={pt.isHuman ? 'font-bold text-yellow-400' : 'text-neutral-400'}>
                  {pt.isHuman ? 'You' : pt.team_name}:{' '}
                  {pt.eliminatedPlayers.length > 0 && (
                    <>lost {pt.eliminatedPlayers.map((p) => `${p.name} (${p.team_name})`).join(', ')}. </>
                  )}
                  {pt.promotions.length > 0 && (
                    <>activated {pt.promotions.map((p) => `${p.in_player} at ${p.slot_label}`).join(', ')}.</>
                  )}
                </p>
              ))}
              {recap.topPerformer && (
                <p className="text-neutral-500">
                  🔥 Top scorer: {recap.topPerformer.isHuman ? 'You' : recap.topPerformer.team_name} — {recap.topPerformer.player_name} (
                  {recap.topPerformer.team_name_played}) put up {recap.topPerformer.points}.
                </p>
              )}
              {recap.leftOnBench && (
                <p className="text-neutral-500">
                  🪑 Left the most on the bench: {recap.leftOnBench.isHuman ? 'You' : recap.leftOnBench.team_name} — {recap.leftOnBench.players.join(', ')} combined for {recap.leftOnBench.points} unused points.
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Visual bracket — same round-by-round data driving the scoring above, truncated
          to whatever round is currently being viewed */}
      {!loadingBracket && roundsHistory.length > 0 && (
        <div className="mb-4">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-yellow-400">Tournament Bracket</p>
          <NcaaBracketView
            regions={REGION_ORDER}
            roundsHistory={roundsHistory.slice(0, viewRoundIdx + 1)}
            rosteredTeamNames={rosteredTeamNames}
          />
        </div>
      )}

      {/* Your roster, as of the round being viewed */}
      <div>
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-yellow-400">
          Your Roster {viewRoundIdx < roundIdx && <span className="text-neutral-500">(as viewed)</span>}
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {SLOT_SEQUENCE.map((slot) => {
            const occupant = occupantAsOf(slot.key, viewRoundIdx);
            const justChanged = viewRoundIdx > 0 && occupant?.acquiredIdx === viewRoundIdx;
            const ended = !occupant ? lastEndedAsOf(slot.key, viewRoundIdx) : null;

            return (
              <div
                key={slot.key}
                className={`rounded border p-2.5 ${
                  !occupant
                    ? 'border-dashed border-neutral-800'
                    : occupant.is_bench
                      ? 'border-neutral-800 bg-neutral-900'
                      : justChanged
                        ? 'border-yellow-400 bg-yellow-400/10'
                        : 'border-yellow-400/20 bg-yellow-400/10'
                }`}
              >
                <p className="text-[10px] font-bold uppercase tracking-wide text-neutral-500">
                  {slot.label}
                  {occupant?.is_bench && <span className="ml-1 rounded bg-neutral-800 px-1 py-0.5 text-neutral-400">Bench</span>}
                  {!occupant && <span className="ml-1 rounded bg-red-900/60 px-1 py-0.5 text-red-300">Eliminated</span>}
                  {justChanged && occupant && !occupant.is_bench && <span className="ml-1 rounded bg-yellow-400 px-1 py-0.5 text-black">NEW</span>}
                </p>
                {occupant ? (
                  <>
                    <p className="mt-0.5 truncate text-sm font-bold text-white">{occupant.player.name}</p>
                    <p className="text-xs text-neutral-500">{occupant.player.team_name} #{occupant.player.team_seed}</p>
                    {viewRoundIdx > 0 && (
                      <p className="mt-1 flex flex-wrap gap-1.5 text-[10px]">
                        {SCORING_ROUNDS.slice(0, viewRoundIdx).map((r) => {
                          const cell = getRoundCell(r.stage, occupant.countedPts, occupant.rawPts, {
                            is_bench: occupant.is_bench,
                            acquired_at_round_stage: stageForRoundIdx(occupant.acquiredIdx) ?? 'r64',
                            released_at_round_stage: stageForRoundIdx(occupant.releasedIdx),
                          });
                          if (cell === null) return null;
                          return (
                            <span key={r.stage} className="flex items-center gap-1 text-neutral-600">
                              {r.short}: <RoundCellBadge cell={cell} />
                            </span>
                          );
                        })}
                      </p>
                    )}
                    {occupant.is_bench && (
                      <p className="mt-1 text-[10px] text-neutral-600">On the bench — activates automatically if your starter&apos;s team goes out.</p>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-neutral-500">
                    {ended
                      ? `${ended.player.name} (${ended.player.team_name} #${ended.player.team_seed}) eliminated — no eligible bench sub`
                      : 'Empty bench slot'}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {isComplete && (
        <div className="mt-4 rounded-lg border border-yellow-400/30 bg-yellow-400/5 p-4 text-center">
          <p className="font-black uppercase tracking-wide text-yellow-400">
            {totals[0].isHuman ? 'You won the league! 🏆' : `${totals[0].name} takes the title.`}
          </p>
          <p className="mt-1 text-sm text-neutral-400">
            This is how scoring works in a real league — eliminated teams stop earning points, and bench
            players automatically activate into open starter slots based on position and PPG.
          </p>
        </div>
      )}
    </div>
  );
}
