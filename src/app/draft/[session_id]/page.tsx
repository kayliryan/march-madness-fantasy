'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import AppHeader from '@/components/AppHeader';
import { DraftQueue } from '@/components/DraftQueue';
import { DraftOrderStrip } from '@/components/DraftOrderStrip';
import { PlayerFilters } from '@/components/PlayerFilters';
import { PlayerSearch } from '@/components/PlayerSearch';
import { Button } from '@/components/ui/button';
import type { DraftPick, DraftSession, GetPlayersQuery, Player } from '@/lib/types';

interface DraftState {
  session: DraftSession;
  picks: DraftPick[];
  available_players: Player[];
  display_names: Record<string, string>;
  current_turn: {
    user_id: string | null;
    pick_number: number;
    round_number: number;
    time_remaining_seconds: number | null;
  };
}

export default function DraftRoomPage() {
  const params = useParams<{ session_id: string }>();
  const session_id = params.session_id;

  const [state, setState] = useState<DraftState | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const [picking, setPicking] = useState(false);
  const [positionFilter, setPositionFilter] = useState<GetPlayersQuery['position'] | undefined>(undefined);
  const [sortOrder, setSortOrder] = useState<NonNullable<GetPlayersQuery['sort']>>('avg_ppg_desc');
  const [search, setSearch] = useState('');
  const [timerSeconds, setTimerSeconds] = useState<number | null>(null);
  const [showPicks, setShowPicks] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [advisorQuestion, setAdvisorQuestion] = useState('');
  const [advisorAdvice, setAdvisorAdvice] = useState<string | null>(null);
  const [advisorLoading, setAdvisorLoading] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [queueRefreshTrigger, setQueueRefreshTrigger] = useState(0);
  const [addingToQueue, setAddingToQueue] = useState<Set<string>>(new Set());
  const [extendSeconds, setExtendSeconds] = useState(60);
  const [extending, setExtending] = useState(false);

  const fetchState = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch(`/api/draft/state/${session_id}`);
      if (res.status === 401) { window.location.href = '/auth/login'; return; }
      if (!res.ok) return;
      const data: DraftState = await res.json();
      setState(data);
      setTimerSeconds(data.current_turn.time_remaining_seconds);
      setReconnecting(false);
    } catch { /* network error */ }
    finally { if (!silent) setLoading(false); }
  }, [session_id]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setCurrentUserId(session?.user?.id ?? null));
    fetchState();
  }, [fetchState]);

  useEffect(() => {
    const heartbeat = setInterval(() => supabase.auth.getSession(), 10 * 60 * 1000);
    return () => clearInterval(heartbeat);
  }, []);

  useEffect(() => {
    if (!state || state.session.status !== 'live') return;
    pollingRef.current = setInterval(() => fetchState(true), 4000);
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, [state?.session.status, fetchState]);

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (timerSeconds === null || timerSeconds <= 0) return;
    timerRef.current = setInterval(() => {
      setTimerSeconds((prev) => {
        if (prev === null || prev <= 1) { if (timerRef.current) clearInterval(timerRef.current); return 0; }
        return prev - 1;
      });
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [timerSeconds]);

  useEffect(() => {
    const channel = supabase.channel(`draft:${session_id}`)
      .on('broadcast', { event: 'PICK_MADE' }, () => { fetchState(true); setPickError(null); })
      .on('broadcast', { event: 'DRAFT_COMPLETE' }, () => fetchState(true))
      .on('broadcast', { event: 'TIMER_EXTENDED' }, () => fetchState(true))
      .on('broadcast', { event: 'TIMER_UPDATE' }, (msg: { payload?: { time_remaining_seconds?: number } }) => {
        const secs = msg.payload?.time_remaining_seconds;
        if (typeof secs === 'number') setTimerSeconds(secs);
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') setReconnecting(false);
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setReconnecting(true);
      });
    return () => { supabase.removeChannel(channel); };
  }, [session_id, fetchState]);

  // QUEUE_UPDATED: server/other devices broadcast to this user's private queue channel
  useEffect(() => {
    if (!currentUserId) return;
    const qChannel = supabase.channel(`queue:${session_id}:${currentUserId}`)
      .on('broadcast', { event: 'QUEUE_UPDATED' }, () => setQueueRefreshTrigger((n) => n + 1))
      .subscribe();
    return () => { supabase.removeChannel(qChannel); };
  }, [session_id, currentUserId]);

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') { setReconnecting(true); fetchState(); }
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [fetchState]);

  async function handleAdvisorAsk() {
    if (advisorLoading) return;
    setAdvisorLoading(true);
    setAdvisorAdvice(null);
    try {
      const res = await fetch('/api/ai/draft-advisor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft_session_id: session_id, question: advisorQuestion.trim() || undefined }),
      });
      const data = await res.json();
      setAdvisorAdvice(res.ok ? data.advice : 'Could not get advice right now. Try again.');
    } catch { setAdvisorAdvice('Could not get advice right now. Try again.'); }
    finally { setAdvisorLoading(false); }
  }

  async function handlePick(player_id: string) {
    if (!state || picking) return;
    setPicking(true);
    setPickError(null);
    try {
      const body = { draft_session_id: session_id, player_id, expected_pick_number: state.current_turn.pick_number };
      const res = await fetch('/api/draft/pick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.status === 401) {
        await supabase.auth.refreshSession();
        const retry = await fetch('/api/draft/pick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!retry.ok) { if (retry.status === 401) window.location.href = '/auth/login'; await fetchState(true); return; }
      } else if (res.status === 422) {
        const err = await res.json();
        const unfilled = (err.unfilled_positions as string[] | undefined)?.join(', ');
        setPickError(unfilled ? `Fill your ${unfilled} starter slot(s) first.` : (err.message ?? 'Position enforcement failed.'));
        await fetchState(true);
        return;
      } else if (!res.ok) { await fetchState(true); return; }
      await fetchState(true);
    } finally { setPicking(false); }
  }

  async function handleAddToQueue(player_id: string) {
    if (!state) return;
    setAddingToQueue((prev) => new Set(prev).add(player_id));
    try {
      await fetch('/api/draft/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft_session_id: session_id, player_id, queue_position: 999 }),
      });
      setQueueRefreshTrigger((n) => n + 1);
    } finally {
      setAddingToQueue((prev) => { const s = new Set(prev); s.delete(player_id); return s; });
    }
  }

  async function handleTimerExtend() {
    if (!state || extending) return;
    setExtending(true);
    try {
      const res = await fetch('/api/draft/timer/extend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft_session_id: session_id, pick_number: state.current_turn.pick_number, extension_seconds: extendSeconds }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error ?? 'Could not extend timer.');
      } else {
        await fetchState(true);
      }
    } finally { setExtending(false); }
  }

  const isMyTurn = !!(currentUserId && state?.current_turn.user_id === currentUserId);
  const isDraftLive = state?.session.status === 'live';
  const isDraftComplete = state?.session.status === 'complete';
  const isDraftScheduled = state?.session.status === 'scheduled';

  const playerNameMap = new Map<string, string>();
  for (const p of (state?.available_players ?? [])) playerNameMap.set(p.id, p.name);

  const availablePlayerIds = new Set((state?.available_players ?? []).map((p) => p.id));

  const filteredPlayers = (state?.available_players ?? [])
    .filter((p) => {
      if (positionFilter && p.position !== positionFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        if (!p.name.toLowerCase().includes(q) && !(p.teams?.name?.toLowerCase() ?? '').includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (sortOrder === 'name') return a.name.localeCompare(b.name);
      if (sortOrder === 'team_seed') return (a.teams?.seed ?? 99) - (b.teams?.seed ?? 99);
      return b.avg_ppg - a.avg_ppg;
    });

  // ── Loading ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-black">
        <AppHeader />
        <div className="flex items-center justify-center py-24">
          <p className="text-neutral-500">Loading draft room…</p>
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="min-h-screen bg-black">
        <AppHeader />
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-24 text-center">
          <p className="text-neutral-300 font-medium">Draft not found or access denied.</p>
          <p className="text-sm text-neutral-500">Make sure you&apos;re a member of this league.</p>
        </div>
      </div>
    );
  }

  // ── Pre-draft waiting room ──────────────────────────────────────────────────
  if (isDraftScheduled) {
    const scheduledAt = state.session.scheduled_start
      ? new Date(state.session.scheduled_start).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : 'TBD';
    return (
      <div className="min-h-screen bg-black">
        <AppHeader />
        <div className="flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-900 p-8 shadow-sm text-center">
          <div className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-full bg-yellow-400/20">
            <svg className="h-7 w-7 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-white">Draft Room</h1>
          <p className="mt-1 text-sm text-neutral-500">Scheduled for</p>
          <p className="mt-1 text-lg font-semibold text-yellow-400">{scheduledAt}</p>

          {Object.keys(state.display_names).length > 0 && (
            <div className="mt-6 text-left">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Participants ({Object.keys(state.display_names).length})
              </p>
              <ul className="space-y-1.5">
                {Object.entries(state.display_names).map(([id, name]) => (
                  <li key={id} className="flex items-center gap-2 text-sm text-neutral-300">
                    <span className={`h-2 w-2 rounded-full ${id === currentUserId ? 'bg-green-400' : 'bg-neutral-700'}`} />
                    {name}{id === currentUserId && <span className="text-xs text-neutral-500">(you)</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="mt-6 text-xs text-neutral-500">Page refreshes automatically when the commissioner starts the draft.</p>
          <button onClick={() => fetchState()} className="mt-2 text-xs text-yellow-400 hover:underline">
            Refresh now
          </button>
        </div>
        </div>
      </div>
    );
  }

  // ── Draft complete ──────────────────────────────────────────────────────────
  if (isDraftComplete) {
    const myPicks = (state.picks ?? []).filter((p) => p.user_id === currentUserId);
    return (
      <div className="min-h-screen bg-black pb-20">
        <AppHeader />
        <div className="mx-auto max-w-2xl px-4 py-8">
          <div className="mb-6 text-center">
            <div className="mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-green-400/20">
              <svg className="h-7 w-7 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-white">Draft Complete!</h1>
            <p className="mt-1 text-sm text-neutral-500">
              {state.picks.length} picks · {Object.keys(state.display_names).length} teams
            </p>
          </div>

          {myPicks.length > 0 && (
            <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-5 shadow-sm">
              <h2 className="mb-3 text-sm font-semibold text-neutral-300 uppercase tracking-wide">Your Team</h2>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {myPicks.map((pick) => (
                  <div key={pick.id} className="rounded-md bg-yellow-400/10 p-2.5">
                    <p className="text-xs text-yellow-200">Pick #{pick.pick_number}</p>
                    <p className="mt-0.5 text-sm font-semibold text-white truncate">
                      {playerNameMap.get(pick.player_id) ?? pick.player_id.slice(0, 8) + '…'}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="mt-6 text-center text-sm text-neutral-500">
            Track your points on the{' '}
            <a href={`/league/${state.session.league_id}/leaderboard`} className="text-yellow-400 hover:underline">
              leaderboard
            </a>.
          </p>
        </div>
        <DraftOrderStrip
          snake_order={state.session.snake_order}
          current_pick_number={state.current_turn.pick_number}
          pick_timer_seconds={state.session.pick_timer_seconds}
          display_names={state.display_names}
          current_user_id={currentUserId}
          is_complete={true}
        />
      </div>
    );
  }

  // ── Live draft ──────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-black pb-20">
      <AppHeader />
      {reconnecting && (
        <div className="fixed inset-x-0 top-0 z-50 bg-yellow-400 py-2 text-center text-sm font-medium text-black">
          Reconnecting…
        </div>
      )}

      <div className="mx-auto max-w-7xl px-4 py-4 sm:py-6">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-white sm:text-2xl">Draft Room</h1>
            {isDraftLive && (
              <p className="mt-0.5 text-sm text-neutral-500">
                Round {state.current_turn.round_number} · Pick {state.current_turn.pick_number}
                {isMyTurn
                  ? <span className="ml-2 font-semibold text-yellow-400">Your pick!</span>
                  : <span className="ml-2 text-neutral-500">Waiting for {state.display_names[state.current_turn.user_id ?? ''] ?? 'another player'}…</span>
                }
              </p>
            )}
          </div>

          {isDraftLive && state.session.pick_timer_seconds && (
            <div className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-4 text-xl font-bold tabular-nums ${
              timerSeconds !== null && timerSeconds <= 10 ? 'border-red-400 text-red-600' : 'border-yellow-400/40 text-yellow-400'
            }`}>
              {timerSeconds !== null && timerSeconds > 0 ? timerSeconds : '—'}
            </div>
          )}
        </div>

        {/* Turn banner — visible on mobile only */}
        {isMyTurn && isDraftLive && (
          <div className="mb-3 rounded-lg bg-yellow-400 px-4 py-2 text-center text-sm font-semibold text-black sm:hidden">
            It&apos;s your turn — pick a player below
          </div>
        )}

        {pickError && (
          <div className="mb-3 rounded-lg border border-red-400/30 bg-red-400/10 px-4 py-2 text-sm text-red-300">
            {pickError}
          </div>
        )}

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          {/* Available players */}
          <div className="lg:col-span-2">
            <div className="rounded-lg border border-neutral-800 bg-neutral-900 shadow-sm">
              <div className="border-b border-neutral-800 px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-base font-semibold text-white">
                    Available Players
                    <span className="ml-2 text-sm font-normal text-neutral-500">({filteredPlayers.length})</span>
                  </h2>
                </div>
                <div className="mt-2">
                  <PlayerFilters position={positionFilter} sort={sortOrder} onPositionChange={setPositionFilter} onSortChange={setSortOrder} />
                </div>
                <div className="mt-2">
                  <PlayerSearch value={search} onChange={setSearch} />
                </div>
              </div>
              <div className="max-h-[45vh] overflow-y-auto sm:max-h-[55vh]">
                {filteredPlayers.length === 0 ? (
                  <p className="py-8 text-center text-sm text-neutral-500">No players match your filters.</p>
                ) : (
                  <ul className="divide-y divide-neutral-800">
                    {filteredPlayers.map((player) => (
                      <li key={player.id} className="flex items-center justify-between py-2.5 px-4">
                        <div className="min-w-0 flex-1">
                          <span className="font-medium text-white">{player.name}</span>
                          <span className="ml-2 text-sm text-neutral-500">
                            {player.position}{player.teams ? ` · ${player.teams.name} (${player.teams.seed})` : ''}
                          </span>
                          <span className="ml-1 text-xs text-neutral-500">{player.avg_ppg} PPG</span>
                        </div>
                        <div className="ml-3 flex shrink-0 items-center gap-1.5">
                          {isDraftLive && (
                            <button
                              onClick={() => handleAddToQueue(player.id)}
                              disabled={addingToQueue.has(player.id)}
                              className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-500 hover:border-yellow-400/40 hover:text-yellow-400 disabled:opacity-40"
                            >
                              {addingToQueue.has(player.id) ? '…' : '+ Queue'}
                            </button>
                          )}
                          {isDraftLive && isMyTurn && !reconnecting && (
                            <Button size="sm" onClick={() => handlePick(player.id)} disabled={picking}>
                              {picking ? '…' : 'Pick'}
                            </Button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>

          {/* Right column */}
          <div className="flex flex-col gap-4">
            <DraftQueue
              sessionId={session_id}
              refreshTrigger={queueRefreshTrigger}
              canDraft={isDraftLive && isMyTurn && !reconnecting}
              availablePlayerIds={availablePlayerIds}
              isPicking={picking}
              onDraft={handlePick}
            />

            {/* Commissioner: timer extend */}
            {isDraftLive && state.session.pick_timer_seconds && (
              <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-3 shadow-sm">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Extend Timer</p>
                <div className="flex gap-2">
                  <select
                    value={extendSeconds}
                    onChange={(e) => setExtendSeconds(Number(e.target.value))}
                    className="flex-1 rounded border border-neutral-800 px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-yellow-400"
                  >
                    {[30, 60, 90, 120].map((s) => <option key={s} value={s}>{s}s</option>)}
                  </select>
                  <Button size="sm" onClick={handleTimerExtend} disabled={extending} className="shrink-0">
                    {extending ? '…' : 'Extend'}
                  </Button>
                </div>
                <p className="mt-1 text-[10px] text-neutral-500">Commissioner-only — server will reject if not authorized.</p>
              </div>
            )}

            {/* AI Advisor */}
            <div className="rounded-lg border border-yellow-400/30 bg-yellow-400/10 p-4 shadow-sm">
              <h2 className="mb-2 text-sm font-semibold text-yellow-300">AI Draft Advisor</h2>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Ask anything… (optional)"
                  value={advisorQuestion}
                  onChange={(e) => setAdvisorQuestion(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAdvisorAsk()}
                  className="flex-1 min-w-0 rounded-md border border-yellow-400/30 bg-neutral-900 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
                />
                <Button size="sm" onClick={handleAdvisorAsk} disabled={advisorLoading} className="shrink-0">
                  {advisorLoading ? '…' : 'Ask'}
                </Button>
              </div>
              {advisorAdvice ? (
                <p className="mt-2 text-sm text-yellow-100 leading-relaxed">{advisorAdvice}</p>
              ) : (
                <p className="mt-2 text-xs text-yellow-200">Ask who to pick, which position to prioritize, or anything draft-related.</p>
              )}
            </div>

            {/* Picks log (collapsible) */}
            <div className="rounded-lg border border-neutral-800 bg-neutral-900 shadow-sm">
              <button
                onClick={() => setShowPicks((p) => !p)}
                className="flex w-full items-center justify-between px-4 py-3 text-left"
              >
                <span className="text-sm font-semibold text-white">
                  Picks Log ({state.picks.length})
                </span>
                <span className="text-xs text-neutral-500">{showPicks ? '▲' : '▼'}</span>
              </button>
              {showPicks && (
                <div className="border-t border-neutral-800 px-4 py-3">
                  {state.picks.length === 0 ? (
                    <p className="text-sm text-neutral-500">No picks yet.</p>
                  ) : (
                    <ol className="max-h-56 overflow-y-auto text-sm divide-y divide-neutral-800">
                      {[...state.picks].reverse().map((pick) => (
                        <li key={pick.id} className="flex items-center gap-2 py-1.5">
                          <span className="w-7 shrink-0 text-right text-xs text-neutral-500">#{pick.pick_number}</span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium text-white">
                              {playerNameMap.get(pick.player_id) ?? pick.player_id.slice(0, 8) + '…'}
                            </p>
                            <p className="text-xs text-neutral-500">{state.display_names[pick.user_id ?? ''] ?? ''}</p>
                          </div>
                          {pick.was_auto_picked && (
                            <span className="shrink-0 rounded bg-neutral-800 px-1 text-xs text-neutral-500">auto</span>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <DraftOrderStrip
        snake_order={state.session.snake_order}
        current_pick_number={state.current_turn.pick_number}
        pick_timer_seconds={state.session.pick_timer_seconds}
        display_names={state.display_names}
        current_user_id={currentUserId}
        is_complete={isDraftComplete}
      />
    </div>
  );
}
