'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
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
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Fetch/refresh state from server ────────────────────────────────────────
  const fetchState = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch(`/api/draft/state/${session_id}`);
      if (res.status === 401) {
        window.location.href = '/auth/login';
        return;
      }
      if (!res.ok) return;
      const data: DraftState = await res.json();
      setState(data);
      setTimerSeconds(data.current_turn.time_remaining_seconds);
      setReconnecting(false);
    } catch {
      // network error — keep showing reconnecting state
    } finally {
      if (!silent) setLoading(false);
    }
  }, [session_id]);

  // ── On mount ────────────────────────────────────────────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setCurrentUserId(session?.user?.id ?? null);
    });
    fetchState();
  }, [fetchState]);

  // ── JWT refresh heartbeat (10 min) ──────────────────────────────────────────
  useEffect(() => {
    const heartbeat = setInterval(() => supabase.auth.getSession(), 10 * 60 * 1000);
    return () => clearInterval(heartbeat);
  }, []);

  // ── Server-side poll (drives auto-pick enforcement) ─────────────────────────
  // Poll every 4 seconds during a live draft. The server checks timer expiry on each request.
  useEffect(() => {
    if (!state || state.session.status !== 'live') return;
    pollingRef.current = setInterval(() => fetchState(true), 4000);
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [state?.session.status, fetchState]);

  // ── Client-side cosmetic countdown ─────────────────────────────────────────
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (timerSeconds === null || timerSeconds <= 0) return;
    timerRef.current = setInterval(() => {
      setTimerSeconds((prev) => {
        if (prev === null || prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [timerSeconds]);

  // ── Realtime subscription ──────────────────────────────────────────────────
  useEffect(() => {
    const channel = supabase
      .channel(`draft:${session_id}`)
      .on('broadcast', { event: 'PICK_MADE' }, () => fetchState(true))
      .on('broadcast', { event: 'DRAFT_COMPLETE' }, () => fetchState(true))
      .on('broadcast', { event: 'TIMER_EXTENDED' }, () => fetchState(true))
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') setReconnecting(false);
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setReconnecting(true);
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [session_id, fetchState]);

  // ── Reconnect on visibility change ─────────────────────────────────────────
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') {
        setReconnecting(true);
        fetchState();
      }
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [fetchState]);

  // ── Submit a manual pick ────────────────────────────────────────────────────
  async function handlePick(player_id: string) {
    if (!state || picking) return;
    setPicking(true);
    try {
      const res = await fetch('/api/draft/pick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          draft_session_id: session_id,
          player_id,
          expected_pick_number: state.current_turn.pick_number,
        }),
      });

      if (res.status === 401) {
        // Token expired — try refresh then retry once
        await supabase.auth.refreshSession();
        const retry = await fetch('/api/draft/pick', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            draft_session_id: session_id,
            player_id,
            expected_pick_number: state.current_turn.pick_number,
          }),
        });
        if (!retry.ok) {
          if (retry.status === 401) window.location.href = '/auth/login';
          await fetchState(true);
          return;
        }
      } else if (!res.ok) {
        await fetchState(true);
        return;
      }

      await fetchState(true);
    } finally {
      setPicking(false);
    }
  }

  // ── Derived state ───────────────────────────────────────────────────────────
  const isMyTurn = !!(currentUserId && state?.current_turn.user_id === currentUserId);
  const isDraftLive = state?.session.status === 'live';
  const isDraftComplete = state?.session.status === 'complete';

  const filteredPlayers = (state?.available_players ?? [])
    .filter((p) => {
      if (positionFilter && p.position !== positionFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        const teamName = p.teams?.name?.toLowerCase() ?? '';
        if (!p.name.toLowerCase().includes(q) && !teamName.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (sortOrder === 'name') return a.name.localeCompare(b.name);
      if (sortOrder === 'team_seed') return (a.teams?.seed ?? 99) - (b.teams?.seed ?? 99);
      return b.avg_ppg - a.avg_ppg; // avg_ppg_desc default
    });

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-gray-500">Loading draft room…</p>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-gray-500">Draft not found.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-16">
      {reconnecting && (
        <div className="fixed inset-x-0 top-0 z-50 bg-yellow-400 py-2 text-center text-sm font-medium text-yellow-900">
          Reconnecting…
        </div>
      )}

      <div className="mx-auto max-w-7xl px-4 py-6">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Draft Room</h1>
            {isDraftLive && (
              <p className="text-sm text-gray-500">
                Round {state.current_turn.round_number} · Pick {state.current_turn.pick_number}
                {state.current_turn.user_id && (
                  <span className="ml-2 font-medium text-indigo-600">
                    {isMyTurn ? 'Your pick' : `Waiting for another player…`}
                  </span>
                )}
              </p>
            )}
            {isDraftComplete && (
              <p className="text-sm font-medium text-green-600">Draft complete!</p>
            )}
          </div>

          {/* Timer */}
          {isDraftLive && state.session.pick_timer_seconds && (
            <div
              className={`flex h-16 w-16 items-center justify-center rounded-full border-4 text-xl font-bold ${
                timerSeconds !== null && timerSeconds <= 10
                  ? 'border-red-400 text-red-600'
                  : 'border-indigo-300 text-indigo-700'
              }`}
            >
              {timerSeconds !== null && timerSeconds > 0 ? timerSeconds : '—'}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Available players */}
          <div className="lg:col-span-2">
            <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <h2 className="mb-3 text-lg font-semibold text-gray-900">Available Players</h2>
              <div className="mb-3">
                <PlayerFilters
                  position={positionFilter}
                  sort={sortOrder}
                  onPositionChange={setPositionFilter}
                  onSortChange={setSortOrder}
                />
                <div className="mt-2">
                  <PlayerSearch value={search} onChange={setSearch} />
                </div>
              </div>
              <div className="max-h-[60vh] overflow-y-auto">
                {filteredPlayers.length === 0 ? (
                  <p className="py-8 text-center text-sm text-gray-400">No players match your filters.</p>
                ) : (
                  <ul className="divide-y divide-gray-100">
                    {filteredPlayers.map((player) => (
                      <li key={player.id} className="flex items-center justify-between py-2 px-1">
                        <div>
                          <span className="font-medium text-gray-900">{player.name}</span>
                          <span className="ml-2 text-sm text-gray-500">
                            {player.position}
                            {player.teams ? ` · ${player.teams.name} (${player.teams.seed})` : ''}
                          </span>
                          <span className="ml-2 text-xs text-gray-400">{player.avg_ppg} PPG</span>
                        </div>
                        {isDraftLive && isMyTurn && !reconnecting && (
                          <Button
                            size="sm"
                            onClick={() => handlePick(player.id)}
                            disabled={picking}
                          >
                            {picking ? '…' : 'Pick'}
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>

          {/* Right column: queue + picks log */}
          <div className="flex flex-col gap-4">
            <DraftQueue sessionId={session_id} />

            {/* Picks log */}
            <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <h2 className="mb-3 text-base font-semibold text-gray-900">
                Picks ({state.picks.length})
              </h2>
              {state.picks.length === 0 ? (
                <p className="text-sm text-gray-400">No picks yet.</p>
              ) : (
                <ol className="max-h-64 overflow-y-auto text-sm">
                  {[...state.picks].reverse().map((pick) => (
                    <li key={pick.id} className="flex items-center gap-2 py-1">
                      <span className="w-8 text-right text-xs text-gray-400">#{pick.pick_number}</span>
                      <span className="text-gray-700">{pick.player_id.slice(0, 8)}…</span>
                      {pick.was_auto_picked && (
                        <span className="rounded bg-gray-100 px-1 text-xs text-gray-500">auto</span>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Draft order strip — pinned to bottom */}
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
