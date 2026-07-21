import type { RoundCell } from '@/lib/utils/roundBreakdown';
import { getPlayerRoundStatus, PLAYER_STATUS_NAME_CLASS } from '@/lib/utils/playerNameStatus';

export interface PlayerNameCellTeam {
  /** Mascot-free school name (e.g. "Duke"). Null for the "Historical" region teams. */
  short_name: string | null;
  /** Full team name — fallback when short_name is absent. */
  name: string;
  seed: number;
}

interface PlayerNameCellProps {
  name: string;
  /** Short position code ("G" | "F" | "C"), shown small — matches the app convention. */
  position?: string | null;
  team: PlayerNameCellTeam | null;
  /** The round's status cell (from cells[stage]) — drives the name color + badges. */
  cell: RoundCell;
}

/**
 * Round-status-aware player name row, used everywhere a roster is broken down
 * round by round (leaderboard/demo expand rows, rounds page, roster page).
 *
 * Renders "<Name> — <School> #<Seed>  <POS>", where only the NAME changes color
 * with the round status (active/green, bench/white, eliminated/grey, pending);
 * the "— School #Seed" portion is always muted. Status + badge decisions come
 * from the pure getPlayerRoundStatus() so they stay unit-testable and consistent.
 */
export function PlayerNameCell({ name, position, team, cell }: PlayerNameCellProps) {
  const { status, showBenchBadge, showElimTag } = getPlayerRoundStatus(cell);
  const school = team ? team.short_name ?? team.name : null;

  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <span className={`font-medium ${PLAYER_STATUS_NAME_CLASS[status]}`}>{name}</span>
      {showBenchBadge && (
        <span className="rounded bg-neutral-800 px-1 py-0.5 text-[10px] text-neutral-500">B</span>
      )}
      {showElimTag && (
        <span className="rounded bg-red-900/30 px-1 py-0.5 text-[10px] font-bold text-red-400">Elim</span>
      )}
      {school && (
        <span className="font-normal text-neutral-500">
          — {school} #{team!.seed}
        </span>
      )}
      {position && <span className="text-xs text-neutral-600">{position}</span>}
    </span>
  );
}
