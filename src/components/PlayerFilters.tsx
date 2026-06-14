'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import type { GetPlayersQuery, GetTeamsResponse, Team } from '@/lib/types';

interface PlayerFiltersProps {
  position: GetPlayersQuery['position'] | undefined;
  sort: NonNullable<GetPlayersQuery['sort']>;
  teamId?: string;
  onPositionChange: (position: GetPlayersQuery['position'] | undefined) => void;
  onSortChange: (sort: NonNullable<GetPlayersQuery['sort']>) => void;
  onTeamChange?: (teamId: string | undefined) => void;
}

const POSITIONS: { value: GetPlayersQuery['position']; label: string }[] = [
  { value: undefined, label: 'All' },
  { value: 'G', label: 'Guards' },
  { value: 'F', label: 'Forwards' },
  { value: 'C', label: 'Centers' },
];

const SORT_OPTIONS: { value: NonNullable<GetPlayersQuery['sort']>; label: string }[] = [
  { value: 'avg_ppg_desc', label: 'Avg PPG (high to low)' },
  { value: 'team_seed', label: 'Team seed' },
  { value: 'name', label: 'Name' },
];

export function PlayerFilters({
  position,
  sort,
  teamId,
  onPositionChange,
  onSortChange,
  onTeamChange,
}: PlayerFiltersProps) {
  const [teams, setTeams] = useState<Pick<Team, 'id' | 'name' | 'seed' | 'region'>[]>([]);

  useEffect(() => {
    if (!onTeamChange) return;
    fetch('/api/teams')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: GetTeamsResponse | null) => {
        if (data) setTeams(data.teams);
      });
  }, [onTeamChange]);

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex gap-1.5">
        {POSITIONS.map((option) => (
          <button
            key={option.label}
            type="button"
            onClick={() => onPositionChange(option.value)}
            className={cn(
              'rounded-full border px-3 py-1 text-sm font-medium transition-colors',
              position === option.value
                ? 'border-yellow-400 bg-yellow-400 text-black'
                : 'border-neutral-700 bg-neutral-900 text-neutral-300 hover:bg-neutral-800'
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-3">
        {onTeamChange && (
          <label className="flex items-center gap-2 text-sm text-neutral-300">
            Team
            <select
              value={teamId ?? ''}
              onChange={(e) => onTeamChange(e.target.value || undefined)}
              className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-white focus:border-yellow-400 focus:outline-none"
            >
              <option value="">All teams</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.region} #{team.seed} {team.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="flex items-center gap-2 text-sm text-neutral-300">
          Sort by
          <select
            value={sort}
            onChange={(e) => onSortChange(e.target.value as NonNullable<GetPlayersQuery['sort']>)}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-white focus:border-yellow-400 focus:outline-none"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
