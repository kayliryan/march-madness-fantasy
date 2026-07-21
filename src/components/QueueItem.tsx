'use client';

import { GripVertical, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PlayerTeamLabel } from '@/components/PlayerTeamLabel';
import type { DraftQueue } from '@/lib/types';

interface QueueItemProps {
  entry: DraftQueue;
  rank: number;
  isDragging?: boolean;
  onRemove: (playerId: string) => void;
  onDragStart: (playerId: string) => void;
  onDragOver: (playerId: string) => void;
  onDrop: () => void;
  onDragEnd: () => void;
  canDraft?: boolean;
  isDrafted?: boolean;
  isPicking?: boolean;
  onDraft?: (playerId: string) => void;
}

const POSITION_LABELS: Record<string, string> = {
  G: 'Guard',
  F: 'Forward',
  C: 'Center',
};

export function QueueItem({
  entry,
  rank,
  isDragging = false,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  canDraft = false,
  isDrafted = false,
  isPicking = false,
  onDraft,
}: QueueItemProps) {
  const player = entry.players;
  const team = player?.teams;

  return (
    <li
      draggable
      onDragStart={() => onDragStart(entry.player_id)}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver(entry.player_id);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
      className={cn(
        'flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-3 shadow-sm',
        isDragging && 'opacity-40'
      )}
    >
      <GripVertical className="size-4 shrink-0 cursor-grab text-neutral-500" />

      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-yellow-400/20 text-xs font-bold text-yellow-400">
        {rank}
      </span>

      <div className="min-w-0 flex-1">
        <PlayerTeamLabel name={player?.name ?? 'Unknown player'} team={team ?? null} />
        <p className="truncate text-xs text-neutral-500">
          {player && (POSITION_LABELS[player.position] ?? player.position)}
          {player && ` · ${player.avg_ppg.toFixed(1)} PPG`}
        </p>
      </div>

      {isDrafted ? (
        <span className="shrink-0 rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-500">Drafted</span>
      ) : canDraft ? (
        <button
          type="button"
          onClick={() => onDraft?.(entry.player_id)}
          disabled={isPicking}
          className="shrink-0 rounded-md bg-yellow-400 px-2.5 py-1 text-xs font-semibold text-black transition-colors hover:bg-yellow-300 disabled:opacity-50"
        >
          {isPicking ? '…' : 'Draft'}
        </button>
      ) : null}

      <button
        type="button"
        onClick={() => onRemove(entry.player_id)}
        aria-label="Remove from queue"
        className="shrink-0 rounded-md p-1 text-neutral-500 transition-colors hover:bg-red-400/10 hover:text-red-400"
      >
        <X className="size-4" />
      </button>
    </li>
  );
}
