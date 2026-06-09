'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import { DraftOrderGenerator } from '@/components/DraftOrderGenerator';
import { DraftScheduler } from '@/components/DraftScheduler';
import { PlayerPositionOverride } from '@/components/PlayerPositionOverride';
import { BenchOrderOverride } from '@/components/BenchOrderOverride';
import type {
  DraftSession,
  GetLeagueResponse,
  GetPlayersResponse,
  League,
  LeagueMember,
  Player,
} from '@/lib/types';

const ROUND_STAGES = ['play_in', 'r64', 'r32', 's16', 'e8', 'f4', 'championship'] as const;
const ROUND_STAGE_LABELS: Record<string, string> = {
  play_in: 'Play-In',
  r64: 'Round of 64',
  r32: 'Round of 32',
  s16: 'Sweet 16',
  e8: 'Elite 8',
  f4: 'Final Four',
  championship: 'Championship',
};

export default function CommissionerPage() {
  const params = useParams<{ league_id: string }>();
  const leagueId = params.league_id;
  const router = useRouter();

  const [league, setLeague] = useState<League | null>(null);
  const [members, setMembers] = useState<LeagueMember[]>([]);
  const [memberLabels, setMemberLabels] = useState<Record<string, string>>({});
  const [players, setPlayers] = useState<Player[]>([]);
  const [draftSession, setDraftSession] = useState<DraftSession | null>(null);

  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);

  // Manual score entry state
  const [scorePlayerId, setScorePlayerId] = useState('');
  const [scorePlayerSearch, setScorePlayerSearch] = useState('');
  const [scoreRoundStage, setScoreRoundStage] = useState<typeof ROUND_STAGES[number]>('r64');
  const [scoreRoundNumber, setScoreRoundNumber] = useState(1);
  const [scoreGameDate, setScoreGameDate] = useState('');
  const [scorePoints, setScorePoints] = useState('');
  const [scoreError, setScoreError] = useState<string | null>(null);
  const [scoreSuccess, setScoreSuccess] = useState(false);
  const [savingScore, setSavingScore] = useState(false);

  // Injury sub state
  const [injuredPlayerId, setInjuredPlayerId] = useState('');
  const [injuredPlayerSearch, setInjuredPlayerSearch] = useState('');
  const [subPlayerId, setSubPlayerId] = useState('');
  const [subPlayerSearch, setSubPlayerSearch] = useState('');
  const [injuryError, setInjuryError] = useState<string | null>(null);
  const [injurySuccess, setInjurySuccess] = useState<string | null>(null);
  const [savingInjurySub, setSavingInjurySub] = useState(false);

  useEffect(() => {
    async function load() {
      setLoading(true);

      const leagueRes = await fetch(`/api/league/${leagueId}`);
      if (leagueRes.status === 401) {
        router.push('/auth/login');
        return;
      }
      if (!leagueRes.ok) {
        setForbidden(true);
        setLoading(false);
        return;
      }

      const leagueData: GetLeagueResponse = await leagueRes.json();

      const role = leagueData.current_member.role;
      if (role !== 'commissioner' && role !== 'co_commissioner') {
        setForbidden(true);
        setLoading(false);
        return;
      }

      setLeague(leagueData.league);
      setMembers(leagueData.members);

      // Member display names for labels (best-effort; falls back to id)
      const userIds = leagueData.members.map((m) => m.user_id);
      const { data: users } = await supabase
        .from('users')
        .select('id, display_name')
        .in('id', userIds);
      if (users) {
        setMemberLabels(
          Object.fromEntries(users.map((u) => [u.id, u.display_name]))
        );
      }

      // Player pool for the position-override tool
      const playersRes = await fetch('/api/players?sort=name');
      if (playersRes.ok) {
        const playersData: GetPlayersResponse = await playersRes.json();
        setPlayers(playersData.players);
      }

      // Existing draft session to prefill schedule/order
      const { data: session } = await supabase
        .from('draft_sessions')
        .select('*')
        .eq('league_id', leagueId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (session) setDraftSession(session as DraftSession);

      setLoading(false);
    }

    load();
  }, [leagueId, router]);

  async function handleSaveOrder(orderedUserIds: string[]) {
    if (!league) return;
    setSavingOrder(true);
    try {
      const res = await fetch('/api/commissioner/draft/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ league_id: leagueId, order: orderedUserIds }),
      });
      if (res.ok) {
        const data = await res.json();
        setDraftSession(data.draft_session as DraftSession);
      }
    } finally {
      setSavingOrder(false);
    }
  }

  async function handleSaveSchedule(p: { scheduled_start: string; pick_timer_seconds: number }) {
    if (!league) return;
    setSavingSchedule(true);
    try {
      const res = await fetch('/api/draft/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ league_id: leagueId, season: league.season, ...p }),
      });
      if (res.ok) {
        const data = await res.json();
        setDraftSession(data.draft_session as DraftSession);
      }
    } finally {
      setSavingSchedule(false);
    }
  }

  async function handleManualScore(e: React.FormEvent) {
    e.preventDefault();
    if (!scorePlayerId) { setScoreError('Select a player.'); return; }
    const pts = parseInt(scorePoints, 10);
    if (isNaN(pts) || pts < 0) { setScoreError('Points must be a non-negative number.'); return; }
    setScoreError(null);
    setScoreSuccess(false);
    setSavingScore(true);
    try {
      const res = await fetch(`/api/league/${leagueId}/scores/manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          player_id: scorePlayerId,
          round_stage: scoreRoundStage,
          round_number: scoreRoundNumber,
          game_date: scoreGameDate,
          points: pts,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        setScoreError(err.error ?? 'Failed to save score');
      } else {
        setScoreSuccess(true);
        setScorePlayerId('');
        setScorePlayerSearch('');
        setScorePoints('');
        setScoreGameDate('');
      }
    } finally {
      setSavingScore(false);
    }
  }

  async function handleInjurySub(e: React.FormEvent) {
    e.preventDefault();
    if (!injuredPlayerId) { setInjuryError('Select the injured player.'); return; }
    setInjuryError(null);
    setInjurySuccess(null);
    setSavingInjurySub(true);
    try {
      const body: Record<string, string> = { league_id: leagueId, injured_player_id: injuredPlayerId };
      if (subPlayerId) body.sub_player_id = subPlayerId;
      const res = await fetch('/api/commissioner/injury-sub', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        setInjuryError(err.error ?? 'Failed to process injury sub');
      } else {
        const data = await res.json();
        const subName = players.find((p) => p.id === data.sub_player_id)?.name ?? data.sub_player_id;
        setInjurySuccess(`Substitution complete. ${subName} is now in the lineup.`);
        setInjuredPlayerId('');
        setInjuredPlayerSearch('');
        setSubPlayerId('');
        setSubPlayerSearch('');
      }
    } finally {
      setSavingInjurySub(false);
    }
  }

  // Resolve a participant's bench (pre-draft this is usually empty)
  const loadBench = useCallback(
    async (userId: string): Promise<Player[]> => {
      const { data: slots } = await supabase
        .from('roster_slots')
        .select('player_id')
        .eq('league_id', leagueId)
        .eq('user_id', userId)
        .eq('is_bench', true)
        .is('released_at_round_stage', null);

      if (!slots || slots.length === 0) return [];
      const ids = new Set(slots.map((s) => s.player_id));
      return players.filter((p) => ids.has(p.id));
    },
    [leagueId, players]
  );

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-gray-500">Loading commissioner tools…</p>
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <p className="text-center text-gray-600">
          You don&apos;t have commissioner access to this league.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-1 text-3xl font-bold text-gray-900">Commissioner Tools</h1>
        <p className="mb-8 text-gray-600">{league?.name}</p>

        <div className="flex flex-col gap-6">
          <DraftOrderGenerator
            members={members}
            memberLabels={memberLabels}
            initialOrder={draftSession?.snake_order}
            onSave={handleSaveOrder}
            saving={savingOrder}
          />

          <DraftScheduler
            initialScheduledStart={draftSession?.scheduled_start}
            initialPickTimerSeconds={draftSession?.pick_timer_seconds}
            onSave={handleSaveSchedule}
            saving={savingSchedule}
          />

          <PlayerPositionOverride
            leagueId={leagueId}
            players={players}
            onSaved={(updated) =>
              setPlayers((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
            }
          />

          <BenchOrderOverride
            leagueId={leagueId}
            members={members}
            memberLabels={memberLabels}
            loadBench={loadBench}
          />

          {/* Injury Substitution */}
          {league?.settings.injury_sub_enabled && (
            <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
              <h2 className="mb-4 text-lg font-semibold text-gray-800">Injury Substitution</h2>
              <form onSubmit={handleInjurySub} className="flex flex-col gap-3">
                {/* Injured player */}
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Injured Player</label>
                  <input
                    type="text"
                    placeholder="Search by name…"
                    value={injuredPlayerSearch}
                    onChange={(e) => { setInjuredPlayerSearch(e.target.value); setInjuredPlayerId(''); setInjurySuccess(null); }}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  {injuredPlayerSearch.trim().length >= 2 && !injuredPlayerId && (
                    <ul className="mt-1 max-h-40 overflow-y-auto rounded-md border border-gray-200 bg-white shadow-sm">
                      {players.filter((p) => p.name.toLowerCase().includes(injuredPlayerSearch.toLowerCase())).slice(0, 6).map((p) => (
                        <li key={p.id} className="cursor-pointer px-3 py-2 text-sm hover:bg-indigo-50"
                          onClick={() => { setInjuredPlayerId(p.id); setInjuredPlayerSearch(p.name); }}>
                          {p.name} <span className="text-gray-400">({p.position})</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {injuredPlayerId && <p className="mt-1 text-xs text-green-600">Selected: {injuredPlayerSearch}</p>}
                </div>

                {/* Optional explicit sub */}
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Sub Player <span className="font-normal text-gray-400">(leave blank to auto-select from bench)</span></label>
                  <input
                    type="text"
                    placeholder="Search by name…"
                    value={subPlayerSearch}
                    onChange={(e) => { setSubPlayerSearch(e.target.value); setSubPlayerId(''); }}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  {subPlayerSearch.trim().length >= 2 && !subPlayerId && (
                    <ul className="mt-1 max-h-40 overflow-y-auto rounded-md border border-gray-200 bg-white shadow-sm">
                      {players.filter((p) => p.name.toLowerCase().includes(subPlayerSearch.toLowerCase())).slice(0, 6).map((p) => (
                        <li key={p.id} className="cursor-pointer px-3 py-2 text-sm hover:bg-indigo-50"
                          onClick={() => { setSubPlayerId(p.id); setSubPlayerSearch(p.name); }}>
                          {p.name} <span className="text-gray-400">({p.position})</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {subPlayerId && <p className="mt-1 text-xs text-green-600">Selected: {subPlayerSearch}</p>}
                </div>

                {injuryError && <p className="text-sm text-red-600">{injuryError}</p>}
                {injurySuccess && <p className="text-sm text-green-600">{injurySuccess}</p>}

                <button
                  type="submit"
                  disabled={savingInjurySub || !injuredPlayerId}
                  className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  {savingInjurySub ? 'Processing…' : 'Apply Injury Sub'}
                </button>
              </form>
            </div>
          )}

          {/* Manual Score Entry */}
          <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold text-gray-800">Enter Score Manually</h2>
            <form onSubmit={handleManualScore} className="flex flex-col gap-3">
              {/* Player search */}
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Player</label>
                <input
                  type="text"
                  placeholder="Search by name…"
                  value={scorePlayerSearch}
                  onChange={(e) => {
                    setScorePlayerSearch(e.target.value);
                    setScorePlayerId('');
                    setScoreSuccess(false);
                  }}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                {scorePlayerSearch.trim().length >= 2 && !scorePlayerId && (
                  <ul className="mt-1 max-h-48 overflow-y-auto rounded-md border border-gray-200 bg-white shadow-sm">
                    {players
                      .filter((p) =>
                        p.name.toLowerCase().includes(scorePlayerSearch.toLowerCase())
                      )
                      .slice(0, 8)
                      .map((p) => (
                        <li
                          key={p.id}
                          className="cursor-pointer px-3 py-2 text-sm hover:bg-indigo-50"
                          onClick={() => {
                            setScorePlayerId(p.id);
                            setScorePlayerSearch(p.name);
                          }}
                        >
                          {p.name} <span className="text-gray-400">({p.position})</span>
                        </li>
                      ))}
                    {players.filter((p) => p.name.toLowerCase().includes(scorePlayerSearch.toLowerCase())).length === 0 && (
                      <li className="px-3 py-2 text-sm text-gray-400">No players found</li>
                    )}
                  </ul>
                )}
                {scorePlayerId && (
                  <p className="mt-1 text-xs text-green-600">Selected: {scorePlayerSearch}</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Round</label>
                  <select
                    value={scoreRoundStage}
                    onChange={(e) => setScoreRoundStage(e.target.value as typeof ROUND_STAGES[number])}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    {ROUND_STAGES.map((s) => (
                      <option key={s} value={s}>{ROUND_STAGE_LABELS[s]}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Round #</label>
                  <input
                    type="number"
                    min={1}
                    value={scoreRoundNumber}
                    onChange={(e) => setScoreRoundNumber(parseInt(e.target.value, 10) || 1)}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Game Date</label>
                  <input
                    type="date"
                    required
                    value={scoreGameDate}
                    onChange={(e) => setScoreGameDate(e.target.value)}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Points</label>
                  <input
                    type="number"
                    min={0}
                    required
                    placeholder="0"
                    value={scorePoints}
                    onChange={(e) => setScorePoints(e.target.value)}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              </div>

              {scoreError && <p className="text-sm text-red-600">{scoreError}</p>}
              {scoreSuccess && (
                <p className="text-sm text-green-600">Score saved and leaderboard is updating.</p>
              )}

              <button
                type="submit"
                disabled={savingScore || !scorePlayerId}
                className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {savingScore ? 'Saving…' : 'Save Score'}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
