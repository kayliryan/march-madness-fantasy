'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { Player } from '@/lib/types';

interface PlayerPositionOverrideProps {
  leagueId: string;
  // A pre-fetched player list to pick from (e.g. from /api/players)
  players: Player[];
  onSaved?: (player: Player) => void;
}

const POSITIONS: ('G' | 'F' | 'C')[] = ['G', 'F', 'C'];

export function PlayerPositionOverride({
  leagueId,
  players,
  onSaved,
}: PlayerPositionOverrideProps) {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [position, setPosition] = useState<'G' | 'F' | 'C'>('G');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const matches = useMemo(() => {
    if (!search.trim()) return [];
    const lower = search.toLowerCase();
    return players.filter((p) => p.name.toLowerCase().includes(lower)).slice(0, 8);
  }, [search, players]);

  const selected = players.find((p) => p.id === selectedId);

  async function handleSave() {
    setError(null);
    setSuccess(null);

    if (!selectedId) {
      setError('Select a player first.');
      return;
    }
    if (!note.trim()) {
      setError('A note is required to override a position.');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/commissioner/player/position', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_id: selectedId, league_id: leagueId, position, override_note: note.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Failed to override position');
      }
      const data = await res.json();
      setSuccess(`Updated ${data.player.name} to ${position}.`);
      setNote('');
      onSaved?.(data.player as Player);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-5 shadow-sm">
      <h3 className="mb-3 text-lg font-semibold text-white">Override Player Position</h3>

      <div className="flex flex-col gap-4">
        <div className="relative flex flex-col gap-1.5">
          <label className="text-sm font-medium text-neutral-300">Player</label>
          <input
            type="text"
            value={selected ? selected.name : search}
            onChange={(e) => {
              setSelectedId('');
              setSearch(e.target.value);
            }}
            placeholder="Search by name…"
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:border-yellow-400 focus:outline-none"
          />
          {!selected && matches.length > 0 && (
            <ul className="absolute top-full z-10 mt-1 w-full overflow-hidden rounded-md border border-neutral-800 bg-neutral-900 shadow-lg">
              {matches.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedId(p.id);
                      setPosition(p.position);
                      setSearch('');
                    }}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-neutral-800"
                  >
                    <span className="text-white">{p.name}</span>
                    <span className="text-neutral-500">
                      {p.position}
                      {p.teams ? ` · ${p.teams.name}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-neutral-300">New position</label>
          <div className="flex gap-2">
            {POSITIONS.map((pos) => (
              <button
                key={pos}
                type="button"
                onClick={() => setPosition(pos)}
                className={`rounded-md border px-4 py-2 text-sm font-medium ${
                  position === pos
                    ? 'border-yellow-400 bg-yellow-400 text-black'
                    : 'border-neutral-700 bg-neutral-900 text-neutral-300 hover:bg-neutral-800'
                }`}
              >
                {pos}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="override-note" className="text-sm font-medium text-neutral-300">
            Note (required)
          </label>
          <textarea
            id="override-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Why is this position being changed?"
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:border-yellow-400 focus:outline-none"
          />
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}
        {success && <p className="text-sm text-green-400">{success}</p>}

        <Button onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Override Position'}
        </Button>
      </div>
    </section>
  );
}
