import type { RoundCell } from '@/lib/utils/roundBreakdown';

/**
 * Renders a single round's scoring cell with consistent visual language
 * everywhere a round-by-round breakdown appears:
 * - counted points: plain text
 * - raw/bench points: strikethrough (played, but doesn't count — "what could have been")
 * - eliminated: small red "Elim" badge
 * - nothing yet: em dash
 */
export function RoundCellBadge({ cell }: { cell: RoundCell }) {
  if (cell === null) {
    return <span className="text-neutral-700">—</span>;
  }
  if (cell.kind === 'counted') {
    return <span className="text-neutral-300">{Math.round(cell.value)}</span>;
  }
  if (cell.kind === 'raw') {
    return (
      <span className="text-neutral-600 line-through" title="Scored, but not counted toward this roster slot">
        {Math.round(cell.value)}
      </span>
    );
  }
  return <span className="rounded bg-red-900/30 px-1 py-0.5 text-[10px] font-bold text-red-500">Elim</span>;
}
