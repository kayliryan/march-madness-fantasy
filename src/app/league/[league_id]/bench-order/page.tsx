'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { format } from 'date-fns';
import { GripVertical } from 'lucide-react';
import AppHeader from '@/components/AppHeader';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase/client';
import { formatCountdown } from '@/lib/utils/formatCountdown';
import type { BenchOrder, GetLeagueResponse } from '@/lib/types';
import type { RosterSlotEnriched } from '@/components/RosterSlotList';

export default function BenchOrderPage() {
  const params = useParams<{ league_id: string }>();
  const { league_id } = params;

  const [league, setLeague] = useState<GetLeagueResponse | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [benchSlots, setBenchSlots] = useState<RosterSlotEnriched[]>([]);
  const [benchOrder, setBenchOrder] = useState<BenchOrder | null>(null);
  const [orderedIds, setOrderedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const draggedId = useRef<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        window.location.href = '/auth/login';
        return;
      }
      if (!active) return;
      setUserId(user.id);

      try {
        const [leagueRes, rosterRes, benchOrderResult] = await Promise.all([
          fetch(`/api/league/${league_id}`),
          fetch(`/api/league/${league_id}/roster/${user.id}`),
          supabase.from('bench_orders').select('*').eq('league_id', league_id).eq('user_id', user.id).maybeSingle(),
        ]);

        if (!active) return;

        if (!leagueRes.ok || !rosterRes.ok) {
          throw new Error('Failed to load bench order');
        }

        const leagueJson: GetLeagueResponse = await leagueRes.json();
        const rosterJson = await rosterRes.json();
        const bo = (benchOrderResult.data as BenchOrder | null) ?? null;

        setLeague(leagueJson);
        setBenchOrder(bo);

        const bench: RosterSlotEnriched[] = rosterJson.active_bench ?? [];
        setBenchSlots(bench);

        if (bo?.submitted_at && bo.ordered_player_ids?.length > 0) {
          const benchIds = new Set(bench.map((s) => s.player_id));
          const ordered = bo.ordered_player_ids.filter((id) => benchIds.has(id));
          const remaining = bench.map((s) => s.player_id).filter((id) => !ordered.includes(id));
          setOrderedIds([...ordered, ...remaining]);
        } else {
          const sorted = [...bench].sort((a, b) => (b.player?.avg_ppg ?? 0) - (a.player?.avg_ppg ?? 0));
          setOrderedIds(sorted.map((s) => s.player_id));
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load bench order');
      } finally {
        if (active) setLoading(false);
      }
    }

    load();
    return () => { active = false; };
  }, [league_id]);

  if (loading) {
    return (
      <div className="min-h-screen bg-black">
        <AppHeader leagueId={league_id} />
        <div className="flex items-center justify-center py-24">
          <p className="text-neutral-500">Loading bench order…</p>
        </div>
      </div>
    );
  }

  if (error || !league) {
    return (
      <div className="min-h-screen bg-black">
        <AppHeader leagueId={league_id} />
        <div className="flex items-center justify-center py-24">
          <p className="text-red-400">{error ?? 'Bench order not found.'}</p>
        </div>
      </div>
    );
  }

  const benchLockDeadline = league.bench_lock_deadline;
  const isLocked = benchLockDeadline != null && new Date(benchLockDeadline) < new Date();
  const slotByPlayerId = new Map(benchSlots.map((s) => [s.player_id, s]));

  function handleDragStart(playerId: string) {
    draggedId.current = playerId;
    setDraggingId(playerId);
  }

  function handleDragOver(targetId: string) {
    const sourceId = draggedId.current;
    if (!sourceId || sourceId === targetId) return;

    setOrderedIds((current) => {
      const sourceIndex = current.indexOf(sourceId);
      const targetIndex = current.indexOf(targetId);
      if (sourceIndex === -1 || targetIndex === -1) return current;

      const reordered = [...current];
      const [moved] = reordered.splice(sourceIndex, 1);
      reordered.splice(targetIndex, 0, moved);
      return reordered;
    });
  }

  function handleDragEnd() {
    draggedId.current = null;
    setDraggingId(null);
  }

  async function handleSave() {
    if (!userId) return;
    setSaving(true);
    setSaveError(null);
    setSuccess(false);
    try {
      const res = await fetch('/api/commissioner/bench-order', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ league_id, user_id: userId, ordered_player_ids: orderedIds }),
      });
      if (!res.ok) {
        const err = await res.json();
        setSaveError(err.message ?? err.error ?? 'Failed to save bench order.');
      } else {
        const data = await res.json();
        setBenchOrder(data.bench_order as BenchOrder);
        setSuccess(true);
        setTimeout(() => setSuccess(false), 4000);
      }
    } catch {
      setSaveError('Failed to save bench order.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-black">
      <AppHeader leagueId={league_id} />
      <div className="mx-auto max-w-2xl px-4 py-8">
        <h1 className="mb-1 text-2xl font-bold text-white">Bench Order</h1>
        <p className="mb-6 text-sm text-neutral-500">
          When an active slot opens up, your bench players are activated in this order.
        </p>

        {league.draft_status !== 'complete' ? (
          <p className="rounded-md border border-dashed border-neutral-700 bg-neutral-900 p-4 text-center text-sm text-neutral-500">
            Your bench order will be available after the draft completes.
          </p>
        ) : (
          <>
            {isLocked ? (
              <div className="mb-4 rounded-md border border-yellow-400/30 bg-yellow-400/10 px-4 py-3 text-sm text-yellow-300">
                Bench order locked on {format(new Date(benchLockDeadline as string), "MMMM d 'at' h:mm a")}
              </div>
            ) : benchLockDeadline != null ? (
              <div className="mb-4 rounded-md border border-yellow-400/30 bg-yellow-400/10 px-4 py-3 text-sm text-yellow-300">
                Bench order locks {formatCountdown(new Date(benchLockDeadline))}
              </div>
            ) : (
              <div className="mb-4 rounded-md border border-neutral-800 bg-neutral-900 px-4 py-3 text-sm text-neutral-400">
                Your bench order can be changed at any time — there is no lock deadline for this league.
              </div>
            )}

            {!isLocked && !benchOrder?.submitted_at && benchSlots.length > 0 && (
              <p className="mb-3 text-xs text-neutral-500">Default order — drag to customize.</p>
            )}

            {benchSlots.length === 0 ? (
              <p className="rounded-md border border-dashed border-neutral-700 bg-neutral-900 p-4 text-center text-sm text-neutral-500">
                You have no bench players.
              </p>
            ) : (
              <ol className="flex flex-col gap-2">
                {orderedIds.map((playerId, index) => {
                  const slot = slotByPlayerId.get(playerId);
                  if (!slot) return null;
                  const player = slot.player;
                  const team = player?.teams;
                  return (
                    <li
                      key={playerId}
                      draggable={!isLocked}
                      onDragStart={() => handleDragStart(playerId)}
                      onDragOver={(e) => {
                        e.preventDefault();
                        handleDragOver(playerId);
                      }}
                      onDrop={(e) => e.preventDefault()}
                      onDragEnd={handleDragEnd}
                      className={cn(
                        'flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-3 shadow-sm',
                        draggingId === playerId && 'opacity-40'
                      )}
                    >
                      {!isLocked && <GripVertical className="size-4 shrink-0 cursor-grab text-neutral-500" />}
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-yellow-400/20 text-xs font-bold text-yellow-400">
                        {index + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-white">{player?.name ?? 'Unknown player'}</p>
                        <p className="truncate text-xs text-neutral-500">
                          {player?.position}
                          {team && ` · ${team.name} (#${team.seed})`}
                          {player && ` · ${player.avg_ppg.toFixed(1)} PPG`}
                        </p>
                      </div>
                      {team?.is_eliminated && (
                        <span className="shrink-0 rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-400">
                          Eliminated
                        </span>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}

            {!isLocked && benchSlots.length > 0 && (
              <div className="mt-5 flex items-center gap-3">
                <Button onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving…' : 'Save Bench Order'}
                </Button>
                {success && <p className="text-sm text-yellow-400">Bench order saved.</p>}
                {saveError && <p className="text-sm text-red-400">{saveError}</p>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
