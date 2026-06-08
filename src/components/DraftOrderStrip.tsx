'use client';

import { cn } from '@/lib/utils';
import { getActiveUserId } from '@/lib/utils/draft';

interface DraftOrderStripProps {
  snake_order: string[];
  current_pick_number: number;
  pick_timer_seconds?: number | null;
  display_names: Record<string, string>;
  current_user_id: string | null;
  is_complete: boolean;
}

function label(user_id: string, display_names: Record<string, string>): string {
  return display_names[user_id] ?? user_id.slice(0, 6);
}

/** Returns the number of picks until user_id picks next (0 = it's their turn). */
function picksUntilMyTurn(
  snake_order: string[],
  current_pick_number: number,
  user_id: string,
  max_lookahead = 200
): number | null {
  for (let i = 0; i < max_lookahead; i++) {
    if (getActiveUserId(snake_order, current_pick_number + i) === user_id) return i;
  }
  return null;
}

/** Returns the snake order for the current round, in pick order. */
function currentRoundOrder(snake_order: string[], current_pick_number: number): string[] {
  const n = snake_order.length;
  if (n === 0) return [];
  const round = Math.ceil(current_pick_number / n);
  return round % 2 === 1 ? [...snake_order] : [...snake_order].reverse();
}

export function DraftOrderStrip({
  snake_order,
  current_pick_number,
  display_names,
  current_user_id,
  is_complete,
}: DraftOrderStripProps) {
  if (snake_order.length === 0) return null;

  const active_user_id = is_complete
    ? null
    : getActiveUserId(snake_order, current_pick_number);

  const round_order = currentRoundOrder(snake_order, current_pick_number);

  const until = current_user_id && !is_complete
    ? picksUntilMyTurn(snake_order, current_pick_number, current_user_id)
    : null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
      <div className="mx-auto flex max-w-7xl items-center gap-0 overflow-x-auto px-4 py-2">
        {/* Order label */}
        <span className="mr-3 shrink-0 text-xs font-medium text-gray-400 uppercase tracking-wide">
          Pick order
        </span>

        {/* Participant chips */}
        {round_order.map((user_id) => {
          const isActive = user_id === active_user_id;
          const isMe = user_id === current_user_id;

          return (
            <div
              key={user_id}
              className={cn(
                'mx-0.5 flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-sm transition-colors',
                isActive
                  ? 'bg-indigo-600 font-semibold text-white ring-2 ring-indigo-300'
                  : isMe
                    ? 'bg-indigo-50 font-medium text-indigo-700 ring-1 ring-indigo-200'
                    : 'bg-gray-100 text-gray-600'
              )}
            >
              {isActive && (
                <span className="inline-block size-2 animate-pulse rounded-full bg-white opacity-80" />
              )}
              <span>{label(user_id, display_names)}</span>
              {isMe && !isActive && (
                <span className="text-xs text-indigo-400">you</span>
              )}
            </div>
          );
        })}

        {/* "X picks until your turn" counter */}
        {until !== null && (
          <span className="ml-4 shrink-0 text-sm text-gray-500">
            {until === 0
              ? 'Your pick'
              : `${until} pick${until === 1 ? '' : 's'} until your turn`}
          </span>
        )}

        {is_complete && (
          <span className="ml-4 shrink-0 text-sm font-medium text-green-600">Draft complete</span>
        )}
      </div>
    </div>
  );
}
