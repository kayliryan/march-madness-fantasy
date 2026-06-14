'use client';

import { useState } from 'react';
import { ArrowDown, ArrowUp, Shuffle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { LeagueMember } from '@/lib/types';

interface DraftOrderGeneratorProps {
  members: LeagueMember[];
  // Optional display labels keyed by user_id (e.g. display names)
  memberLabels?: Record<string, string>;
  initialOrder?: string[];
  onSave: (orderedUserIds: string[]) => Promise<void>;
  saving?: boolean;
}

export function DraftOrderGenerator({
  members,
  memberLabels = {},
  initialOrder,
  onSave,
  saving = false,
}: DraftOrderGeneratorProps) {
  const [mode, setMode] = useState<'random' | 'manual'>('random');
  const [order, setOrder] = useState<string[]>(
    initialOrder && initialOrder.length > 0
      ? initialOrder
      : members.map((m) => m.user_id)
  );

  function shuffle() {
    const shuffled = [...order];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    setOrder(shuffled);
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
  }

  function label(userId: string) {
    return memberLabels[userId] ?? userId.slice(0, 8);
  }

  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-5 shadow-sm">
      <h3 className="mb-3 text-lg font-semibold text-white">Draft Order</h3>

      <div className="mb-4 flex gap-2">
        {(['random', 'manual'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cn(
              'rounded-full border px-3 py-1 text-sm font-medium capitalize transition-colors',
              mode === m
                ? 'border-yellow-400 bg-yellow-400 text-black'
                : 'border-neutral-700 bg-neutral-900 text-neutral-300 hover:bg-neutral-800'
            )}
          >
            {m}
          </button>
        ))}
        {mode === 'random' && (
          <Button variant="outline" size="sm" onClick={shuffle}>
            <Shuffle className="size-4" /> Shuffle
          </Button>
        )}
      </div>

      <ol className="mb-4 flex flex-col gap-2">
        {order.map((userId, index) => (
          <li
            key={userId}
            className="flex items-center gap-3 rounded-md border border-neutral-800 bg-black px-3 py-2"
          >
            <span className="flex size-6 items-center justify-center rounded-full bg-yellow-400/20 text-xs font-bold text-yellow-400">
              {index + 1}
            </span>
            <span className="flex-1 text-sm text-neutral-200">{label(userId)}</span>
            {mode === 'manual' && (
              <span className="flex gap-1">
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  aria-label="Move up"
                  className="rounded p-1 text-neutral-500 hover:bg-neutral-700 disabled:opacity-30"
                >
                  <ArrowUp className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === order.length - 1}
                  aria-label="Move down"
                  className="rounded p-1 text-neutral-500 hover:bg-neutral-700 disabled:opacity-30"
                >
                  <ArrowDown className="size-4" />
                </button>
              </span>
            )}
          </li>
        ))}
      </ol>

      <Button onClick={() => onSave(order)} disabled={saving}>
        {saving ? 'Saving…' : 'Save Draft Order'}
      </Button>
    </section>
  );
}
