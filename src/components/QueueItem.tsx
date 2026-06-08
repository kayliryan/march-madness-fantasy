'use client';

import { GripVertical, X } from 'lucide-react';
import { cn } from '@/lib/utils';
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
        'flex items-center gap-3 rounded-lg border border-gray-200 bg-white p-3 shadow-sm',
        isDragging && 'opacity-40'
      )}
    >
      <GripVertical className="size-4 shrink-0 cursor-grab text-gray-400" />

      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">
        {rank}
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-gray-900">
          {player?.name ?? 'Unknown player'}
        </p>
        <p className="truncate text-xs text-gray-500">
          {player && (POSITION_LABELS[player.position] ?? player.position)}
          {team && ` · ${team.name}`}
          {player && ` · ${player.avg_ppg.toFixed(1)} PPG`}
        </p>
      </div>

      <button
        type="button"
        onClick={() => onRemove(entry.player_id)}
        aria-label="Remove from queue"
        className="shrink-0 rounded-md p-1 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600"
      >
        <X className="size-4" />
      </button>
    </li>
  );
}
