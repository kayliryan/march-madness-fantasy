export interface PlayerTeamLabelTeam {
  /** Mascot-free school name (e.g. "Duke"). Null for the "Historical" region teams. */
  short_name: string | null;
  /** Full team name — fallback when short_name is absent. */
  name: string;
  seed: number;
}

interface PlayerTeamLabelProps {
  name: string;
  /** Short position code ("G" | "F" | "C"), shown small. Optional. */
  position?: string | null;
  team: PlayerTeamLabelTeam | null;
  /** Override the name text color (defaults to text-white). */
  nameClassName?: string;
}

/**
 * Plain "<Name> — <School> #<Seed>  <POS>" label for draft-time / admin
 * contexts where there is no round concept (pre-draft, commissioner search
 * pickers, bench order). Same format and muted team/seed styling as
 * PlayerNameCell, but no status color or badges. Callers never deal with the
 * short_name ?? name fallback — it's done here.
 */
export function PlayerTeamLabel({ name, position, team, nameClassName = 'text-white' }: PlayerTeamLabelProps) {
  const school = team ? team.short_name ?? team.name : null;

  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <span className={`font-medium ${nameClassName}`}>{name}</span>
      {school && (
        <span className="font-normal text-neutral-500">
          — {school} #{team!.seed}
        </span>
      )}
      {position && <span className="text-xs text-neutral-600">{position}</span>}
    </span>
  );
}
