'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import AppHeader from '@/components/AppHeader';
import { PlayerCard } from '@/components/PlayerCard';
import { PlayerFilters } from '@/components/PlayerFilters';
import { PlayerSearch } from '@/components/PlayerSearch';
import type { GetPlayersQuery, GetPlayersResponse, Player } from '@/lib/types';

function PlayersExplorer() {
  const searchParams = useSearchParams();
  const leagueId = searchParams.get('league_id');

  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [position, setPosition] = useState<GetPlayersQuery['position'] | undefined>(undefined);
  const [sort, setSort] = useState<NonNullable<GetPlayersQuery['sort']>>('avg_ppg_desc');
  const [search, setSearch] = useState('');
  const [teamId, setTeamId] = useState<string | undefined>(undefined);

  const [draftSessionId, setDraftSessionId] = useState<string | null>(null);
  const [draftedPlayerIds, setDraftedPlayerIds] = useState<Set<string>>(new Set());
  const [queuedPlayerIds, setQueuedPlayerIds] = useState<Set<string>>(new Set());
  const [addingPlayerId, setAddingPlayerId] = useState<string | null>(null);

  // Fetch players whenever filters change
  useEffect(() => {
    const controller = new AbortController();

    async function fetchPlayers() {
      setLoading(true);
      setError(null);

      const params = new URLSearchParams();
      if (position) params.set('position', position);
      if (sort) params.set('sort', sort);
      if (search) params.set('search', search);
      if (teamId) params.set('team_id', teamId);

      try {
        const res = await fetch(`/api/players?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('Failed to load players');
        const data: GetPlayersResponse = await res.json();
        setPlayers(data.players);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError('Could not load players. Please try again.');
        }
      } finally {
        setLoading(false);
      }
    }

    fetchPlayers();
    return () => controller.abort();
  }, [position, sort, search, teamId]);

  // League/draft context: lets us mark drafted players and wire "Add to Queue"
  useEffect(() => {
    if (!leagueId) return;

    async function loadLeagueContext() {
      const { data: session } = await supabase
        .from('draft_sessions')
        .select('id')
        .eq('league_id', leagueId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!session) return;
      setDraftSessionId(session.id);

      const [{ data: rosterSlots }, queueRes] = await Promise.all([
        supabase
          .from('roster_slots')
          .select('player_id')
          .eq('league_id', leagueId)
          .is('released_at_round_stage', null),
        fetch(`/api/draft/queue?session_id=${session.id}`),
      ]);

      if (rosterSlots) {
        setDraftedPlayerIds(new Set(rosterSlots.map((r) => r.player_id)));
      }

      if (queueRes.ok) {
        const queueData: { queue: { player_id: string }[] } = await queueRes.json();
        setQueuedPlayerIds(new Set(queueData.queue.map((q) => q.player_id)));
      }
    }

    loadLeagueContext();
  }, [leagueId]);

  async function handleAddToQueue(player: Player) {
    if (!draftSessionId) return;

    setAddingPlayerId(player.id);
    try {
      const res = await fetch('/api/draft/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft_session_id: draftSessionId, player_id: player.id }),
      });
      if (res.ok) {
        setQueuedPlayerIds((prev) => new Set(prev).add(player.id));
      }
    } finally {
      setAddingPlayerId(null);
    }
  }

  const emptyState = useMemo(() => {
    if (loading) return null;
    if (error) return error;
    if (players.length === 0) return 'No players match your filters.';
    return null;
  }, [loading, error, players.length]);

  return (
    <div className="min-h-screen bg-black">
      <AppHeader leagueId={leagueId ?? undefined} />
      <div className="px-4 py-8">
        <div className="mx-auto max-w-6xl">
          <h1 className="mb-6 text-3xl font-bold text-white">Player Explorer</h1>

          <div className="mb-6 flex flex-col gap-4">
            <PlayerSearch value={search} onChange={setSearch} />
            <PlayerFilters
              position={position}
              sort={sort}
              teamId={teamId}
              onPositionChange={setPosition}
              onSortChange={setSort}
              onTeamChange={setTeamId}
            />
          </div>

          {emptyState ? (
            <p className="py-12 text-center text-neutral-500">{emptyState}</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {players.map((player) => (
                <PlayerCard
                  key={player.id}
                  player={player}
                  isDrafted={draftedPlayerIds.has(player.id)}
                  isQueued={queuedPlayerIds.has(player.id)}
                  addingToQueue={addingPlayerId === player.id}
                  onAddToQueue={leagueId && draftSessionId ? handleAddToQueue : undefined}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function PlayersPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-black">
          <p className="text-neutral-500">Loading players…</p>
        </div>
      }
    >
      <PlayersExplorer />
    </Suspense>
  );
}
