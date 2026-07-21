'use client';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { InjuryBadge } from '@/components/InjuryBadge';
import { PlayerTeamLabel } from '@/components/PlayerTeamLabel';
import type { Player } from '@/lib/types';

interface PlayerCardProps {
  player: Player;
  isDrafted?: boolean;
  isQueued?: boolean;
  onAddToQueue?: (player: Player) => void;
  addingToQueue?: boolean;
}

const POSITION_LABELS: Record<string, string> = {
  G: 'Guard',
  F: 'Forward',
  C: 'Center',
};

export function PlayerCard({
  player,
  isDrafted = false,
  isQueued = false,
  onAddToQueue,
  addingToQueue = false,
}: PlayerCardProps) {
  const team = player.teams;

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4 shadow-sm transition-opacity',
        isDrafted && 'opacity-50'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <PlayerTeamLabel name={player.name} team={team ?? null} nameClassName="text-white font-semibold" />
          <p className="mt-0.5 text-sm text-neutral-500">{POSITION_LABELS[player.position] ?? player.position}</p>
        </div>
        {isDrafted && (
          <span className="shrink-0 rounded-full bg-neutral-800 px-2 py-0.5 text-xs font-semibold text-neutral-400">
            Taken
          </span>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-2xl font-bold text-white">{player.avg_ppg.toFixed(1)}</p>
          <p className="text-xs text-neutral-500">avg PPG</p>
        </div>
        <InjuryBadge
          status={player.injury_status}
          note={player.injury_note}
          updatedAt={player.injury_updated_at}
        />
      </div>

      {onAddToQueue && (
        <Button
          size="sm"
          variant={isQueued ? 'secondary' : 'outline'}
          disabled={isDrafted || isQueued || addingToQueue}
          onClick={() => onAddToQueue(player)}
        >
          {isDrafted ? 'Drafted' : isQueued ? 'In Queue' : addingToQueue ? 'Adding…' : 'Add to Queue'}
        </Button>
      )}
    </div>
  );
}
