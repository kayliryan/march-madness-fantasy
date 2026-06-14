'use client';

import { Search } from 'lucide-react';

interface PlayerSearchProps {
  value: string;
  onChange: (value: string) => void;
}

export function PlayerSearch({ value, onChange }: PlayerSearchProps) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-neutral-500" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search players or teams…"
        className="w-full rounded-md border border-neutral-700 bg-neutral-900 py-2 pr-3 pl-9 text-sm text-white placeholder:text-neutral-500 focus:border-yellow-400 focus:outline-none"
      />
    </div>
  );
}
