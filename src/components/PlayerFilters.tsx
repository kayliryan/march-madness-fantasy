'use client';

import { cn } from '@/lib/utils';
import type { GetPlayersQuery } from '@/lib/types';

interface PlayerFiltersProps {
  position: GetPlayersQuery['position'] | undefined;
  sort: NonNullable<GetPlayersQuery['sort']>;
  onPositionChange: (position: GetPlayersQuery['position'] | undefined) => void;
  onSortChange: (sort: NonNullable<GetPlayersQuery['sort']>) => void;
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
  onPositionChange,
  onSortChange,
}: PlayerFiltersProps) {
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
                ? 'border-indigo-600 bg-indigo-600 text-white'
                : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      <label className="flex items-center gap-2 text-sm text-gray-600">
        Sort by
        <select
          value={sort}
          onChange={(e) => onSortChange(e.target.value as NonNullable<GetPlayersQuery['sort']>)}
          className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none"
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
