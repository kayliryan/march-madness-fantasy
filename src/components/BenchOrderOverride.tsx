'use client';

import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { LeagueMember, Player } from '@/lib/types';

interface BenchOrderOverrideProps {
  leagueId: string;
  members: LeagueMember[];
  memberLabels?: Record<string, string>;
  // Resolves a participant's current bench player ids -> ordered Player rows.
  // The page supplies this so the component stays free of data-fetching specifics.
  loadBench: (userId: string) => Promise<Player[]>;
}

export function BenchOrderOverride({
  leagueId,
  members,
  memberLabels = {},
  loadBench,
}: BenchOrderOverrideProps) {
  const [selectedUserId, setSelectedUserId] = useState('');
  const [bench, setBench] = useState<Player[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedUserId) {
      setBench([]);
      return;
    }
    let active = true;
    setLoading(true);
    setMessage(null);
    loadBench(selectedUserId)
      .then((players) => {
        if (active) setBench(players);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedUserId, loadBench]);

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= bench.length) return;
    const next = [...bench];
    [next[index], next[target]] = [next[target], next[index]];
    setBench(next);
  }

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/commissioner/bench-order', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          league_id: leagueId,
          user_id: selectedUserId,
          ordered_player_ids: bench.map((p) => p.id),
        }),
      });
      setMessage(res.ok ? 'Bench order saved.' : 'Failed to save bench order.');
    } catch {
      setMessage('Failed to save bench order.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <h3 className="mb-3 text-lg font-semibold text-gray-900">Override Bench Order</h3>

      <div className="mb-4 flex flex-col gap-1.5">
        <label htmlFor="bench-participant" className="text-sm font-medium text-gray-700">
          Participant
        </label>
        <select
          id="bench-participant"
          value={selectedUserId}
          onChange={(e) => setSelectedUserId(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none"
        >
          <option value="">Select a participant…</option>
          {members.map((m) => (
            <option key={m.user_id} value={m.user_id}>
              {memberLabels[m.user_id] ?? m.user_id.slice(0, 8)}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="py-4 text-sm text-gray-500">Loading bench…</p>
      ) : selectedUserId && bench.length === 0 ? (
        <p className="py-4 text-sm text-gray-500">This participant has no bench players yet.</p>
      ) : (
        bench.length > 0 && (
          <ol className="mb-4 flex flex-col gap-2">
            {bench.map((player, index) => (
              <li
                key={player.id}
                className="flex items-center gap-3 rounded-md border border-gray-200 bg-gray-50 px-3 py-2"
              >
                <span className="flex size-6 items-center justify-center rounded-full bg-gray-200 text-xs font-bold text-gray-600">
                  {index + 1}
                </span>
                <span className="flex-1 text-sm text-gray-800">
                  {player.name}
                  <span className="text-gray-400"> · {player.position}</span>
                </span>
                <span className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    aria-label="Move up"
                    className="rounded p-1 text-gray-400 hover:bg-gray-200 disabled:opacity-30"
                  >
                    <ArrowUp className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={index === bench.length - 1}
                    aria-label="Move down"
                    className="rounded p-1 text-gray-400 hover:bg-gray-200 disabled:opacity-30"
                  >
                    <ArrowDown className="size-4" />
                  </button>
                </span>
              </li>
            ))}
          </ol>
        )
      )}

      {message && <p className="mb-3 text-sm text-gray-600">{message}</p>}

      {bench.length > 0 && (
        <Button onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save Bench Order'}
        </Button>
      )}
    </section>
  );
}
