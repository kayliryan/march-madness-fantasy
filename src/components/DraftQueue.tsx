'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { QueueItem } from '@/components/QueueItem';
import type { AddToQueueResponse, DraftQueue as DraftQueueEntry } from '@/lib/types';

interface DraftQueueProps {
  sessionId: string;
  refreshTrigger?: number; // increment to force a re-fetch
  canDraft?: boolean; // true when it's the user's turn and a pick can be submitted
  availablePlayerIds?: Set<string>; // players not yet drafted
  isPicking?: boolean;
  onDraft?: (playerId: string) => void;
}

export function DraftQueue({ sessionId, refreshTrigger, canDraft, availablePlayerIds, isPicking, onDraft }: DraftQueueProps) {
  const [queue, setQueue] = useState<DraftQueueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const draggedId = useRef<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/draft/queue?session_id=${sessionId}`);
      if (!res.ok) throw new Error('Failed to load queue');
      const data: AddToQueueResponse = await res.json();
      setQueue(data.queue);
    } catch {
      setError('Could not load your queue.');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { loadQueue(); }, [loadQueue]);

  useEffect(() => {
    if (refreshTrigger !== undefined && refreshTrigger > 0) loadQueue();
  }, [refreshTrigger, loadQueue]);

  async function handleRemove(playerId: string) {
    // Optimistic removal
    const previous = queue;
    setQueue((q) => q.filter((entry) => entry.player_id !== playerId));

    const res = await fetch(`/api/draft/queue/${sessionId}/${playerId}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      setQueue(previous); // roll back
      setError('Could not remove player. Please try again.');
    }
  }

  function handleDragStart(playerId: string) {
    draggedId.current = playerId;
    setDraggingId(playerId);
  }

  function handleDragOver(targetId: string) {
    const sourceId = draggedId.current;
    if (!sourceId || sourceId === targetId) return;

    setQueue((current) => {
      const sourceIndex = current.findIndex((e) => e.player_id === sourceId);
      const targetIndex = current.findIndex((e) => e.player_id === targetId);
      if (sourceIndex === -1 || targetIndex === -1) return current;

      const reordered = [...current];
      const [moved] = reordered.splice(sourceIndex, 1);
      reordered.splice(targetIndex, 0, moved);
      return reordered;
    });
  }

  async function handleDrop() {
    // Persist new positions for any entries whose rank changed
    const updates = queue
      .map((entry, index) => ({ entry, position: index + 1 }))
      .filter(({ entry, position }) => entry.queue_position !== position);

    // Reflect new positions locally so subsequent diffs are accurate
    setQueue((current) =>
      current.map((entry, index) => ({ ...entry, queue_position: index + 1 }))
    );

    await Promise.all(
      updates.map(({ entry, position }) =>
        fetch(`/api/draft/queue/${sessionId}/${entry.player_id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ queue_position: position }),
        })
      )
    );
  }

  function handleDragEnd() {
    draggedId.current = null;
    setDraggingId(null);
  }

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <h2 className="mb-1 text-lg font-bold text-white">Your Draft Queue</h2>
      <p className="mb-4 text-sm text-neutral-500">
        Drag to reorder. Players auto-pick from the top of this list if your timer runs out.
      </p>

      {loading ? (
        <p className="py-6 text-center text-sm text-neutral-500">Loading…</p>
      ) : error ? (
        <p className="py-6 text-center text-sm text-red-400">{error}</p>
      ) : queue.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-700 bg-black p-4 text-center text-sm text-neutral-500">
          Your queue is empty. If you don&apos;t set one, auto-picks will fall back to the
          best available player by average PPG.
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {queue.map((entry, index) => {
            const isDrafted = availablePlayerIds !== undefined && !availablePlayerIds.has(entry.player_id);
            return (
              <QueueItem
                key={entry.player_id}
                entry={entry}
                rank={index + 1}
                isDragging={draggingId === entry.player_id}
                onRemove={handleRemove}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                onDragEnd={handleDragEnd}
                canDraft={canDraft && !isDrafted}
                isDrafted={isDrafted}
                isPicking={isPicking}
                onDraft={onDraft}
              />
            );
          })}
        </ol>
      )}
    </div>
  );
}
