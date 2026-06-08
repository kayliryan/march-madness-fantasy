import type { LeagueSettings } from '@/lib/types';

/** Returns the user_id whose turn it is for the given pick number (1-indexed). */
export function getActiveUserId(snake_order: string[], pick_number: number): string {
  const n = snake_order.length;
  const round = Math.ceil(pick_number / n);
  const pos = (pick_number - 1) % n;
  return round % 2 === 1 ? snake_order[pos] : snake_order[n - 1 - pos];
}

/** Total picks in a complete draft. */
export function computeMaxPicks(settings: LeagueSettings, member_count: number): number {
  const starter_count = Object.values(settings.starter_slots).reduce((a, b) => a + b, 0);
  return member_count * (starter_count + settings.bench_slots);
}
