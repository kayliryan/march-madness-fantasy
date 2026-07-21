import type { RoundCell } from '@/lib/utils/roundBreakdown';

/**
 * Presentational status for a player's NAME in a round-by-round breakdown.
 * This is a THIN mapping on top of the already-correct RoundCell.kind produced
 * by getRoundCell()/mergePlayerRounds() — it invents no new status logic, it
 * only decides how the name row should look for one round:
 *
 *   RoundCell.kind        status        name color    badges
 *   ------------------    ----------    -----------   -----------------------
 *   'counted'             active        green         (none)
 *   'raw'                 bench         white         "B" badge
 *   'elim'                eliminated    grey          "Elim" tag
 *   null                  pending       muted grey    (none)
 *
 * The bench badge and elim tag are mutually exclusive by construction — a
 * single RoundCell is exactly one kind, so a round is never simultaneously
 * tagged bench AND eliminated.
 *
 * Extracted from the React component on purpose so it is unit-testable in
 * isolation (see scripts/test/unit-player-name-cell-status.ts).
 */
export type PlayerRoundStatus = 'active' | 'bench' | 'eliminated' | 'pending';

export interface PlayerRoundStatusResult {
  status: PlayerRoundStatus;
  /** Show the small "B" bench badge next to the name. */
  showBenchBadge: boolean;
  /** Show the small "Elim" tag next to the name. */
  showElimTag: boolean;
}

export function getPlayerRoundStatus(cell: RoundCell): PlayerRoundStatusResult {
  if (cell === null) {
    return { status: 'pending', showBenchBadge: false, showElimTag: false };
  }
  if (cell.kind === 'counted') {
    return { status: 'active', showBenchBadge: false, showElimTag: false };
  }
  if (cell.kind === 'raw') {
    return { status: 'bench', showBenchBadge: true, showElimTag: false };
  }
  // 'elim'
  return { status: 'eliminated', showBenchBadge: false, showElimTag: true };
}

/**
 * Tailwind class for the player NAME text, keyed by status. Kept beside the
 * pure status function so the color choices live in one place and stay
 * consistent with the app's existing conventions:
 * - active  → text-green-400 (the app's dominant "active/success" green:
 *   InjuryBadge active state, success messages, "Draft complete")
 * - bench   → text-white (legible, matches the existing bench-name convention)
 * - eliminated → text-neutral-500 (greyed out)
 * - pending → text-neutral-600 (dimmer still — lowest visual priority)
 */
export const PLAYER_STATUS_NAME_CLASS: Record<PlayerRoundStatus, string> = {
  active: 'text-green-400',
  bench: 'text-white',
  eliminated: 'text-neutral-500',
  pending: 'text-neutral-600',
};
