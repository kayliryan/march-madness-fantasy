'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';

interface InjuryBadgeProps {
  status?: 'active' | 'day_to_day' | 'out' | null;
  note?: string | null;
  updatedAt?: string | null;
}

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  day_to_day: 'bg-yellow-100 text-yellow-800',
  out: 'bg-red-100 text-red-700',
};

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  day_to_day: 'Day-to-Day',
  out: 'Out',
};

export function InjuryBadge({ status, note, updatedAt }: InjuryBadgeProps) {
  const [open, setOpen] = useState(false);

  // Healthy/active players with no note don't need a badge cluttering the card
  if (!status || status === 'active') {
    return null;
  }

  return (
    <span
      className="relative inline-block"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span
        className={cn(
          'inline-flex cursor-default items-center rounded-full px-2 py-0.5 text-xs font-medium',
          STATUS_STYLES[status]
        )}
      >
        {STATUS_LABELS[status] ?? status}
      </span>

      {open && (note || updatedAt) && (
        <span className="absolute bottom-full left-1/2 z-10 mb-2 w-48 -translate-x-1/2 rounded-md bg-gray-900 px-3 py-2 text-xs text-white shadow-lg">
          {note && <span className="block font-medium">{note}</span>}
          {updatedAt && (
            <span className="mt-1 block text-gray-300">
              Updated {new Date(updatedAt).toLocaleDateString()}
            </span>
          )}
          <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
        </span>
      )}
    </span>
  );
}
