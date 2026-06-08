'use client';

import { Search } from 'lucide-react';

interface PlayerSearchProps {
  value: string;
  onChange: (value: string) => void;
}

export function PlayerSearch({ value, onChange }: PlayerSearchProps) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-gray-400" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search players or teams…"
        className="w-full rounded-md border border-gray-300 bg-white py-2 pr-3 pl-9 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none"
      />
    </div>
  );
}
