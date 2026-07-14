import type { BracketTeam } from '@/lib/utils/bracketSim';

const REGION_COLUMN_LABELS = ['R64', 'R32', 'S16', 'E8', 'Champ'];

/**
 * Visual bracket for the Season Simulator. `roundsHistory` is the sequence of
 * "still alive entering this round" snapshots produced by repeatedly calling
 * simulateBracketRound(): index 0 = all 64 teams (pre-tournament), index 4 = the
 * 4 regional champions, index 6 = the national champion. Everything renders
 * from this one array — no separate bracket-vs-scoring state to keep in sync.
 */
export function NcaaBracketView({
  regions,
  roundsHistory,
  rosteredTeamNames,
}: {
  regions: string[];
  roundsHistory: BracketTeam[][];
  rosteredTeamNames?: Set<string>;
}) {
  const revealedRounds = roundsHistory.length - 1; // how many rounds have actually been played

  function TeamRow({ team, stillAlive }: { team: BracketTeam; stillAlive: boolean }) {
    const rostered = rosteredTeamNames?.has(team.name);
    return (
      <div
        className={`flex items-center gap-1.5 truncate rounded px-1.5 py-1 text-[11px] ${
          stillAlive ? (rostered ? 'bg-yellow-400/10 text-yellow-300' : 'text-neutral-200') : 'text-neutral-600 line-through'
        }`}
        title={rostered ? 'You have a player on this team' : undefined}
      >
        <span className="w-4 shrink-0 text-center font-mono text-[9px] text-neutral-500">{team.seed}</span>
        <span className="truncate font-medium">{team.name}</span>
        {rostered && stillAlive && <span className="shrink-0 text-yellow-400">★</span>}
      </div>
    );
  }

  function RegionColumns({ region }: { region: string }) {
    // For each of the 5 region-local rounds (R64 field → Elite 8 winner),
    // pull this region's slice out of the corresponding national snapshot.
    const columns = [0, 1, 2, 3, 4].map((r) => (roundsHistory[r] ?? []).filter((t) => t.region === region));
    return (
      <div className="min-w-0 flex-1">
        <p className="mb-1.5 text-center text-[10px] font-bold uppercase tracking-wide text-yellow-400">{region}</p>
        <div className="flex gap-1.5">
          {columns.map((teams, colIdx) => {
            if (colIdx > revealedRounds) return null;
            // A team in this column is "still alive" if it also appears in the NEXT column
            // (i.e. it won its game) or this is the last column we've simulated so far.
            const nextTeams = colIdx < revealedRounds ? new Set((roundsHistory[colIdx + 1] ?? []).map((t) => t.name)) : null;
            return (
              <div key={colIdx} className="min-w-0 flex-1 space-y-0.5">
                <p className="mb-1 text-center text-[9px] font-bold uppercase tracking-widest text-neutral-600">
                  {REGION_COLUMN_LABELS[colIdx]}
                </p>
                {teams.map((team) => (
                  <TeamRow key={team.name} team={team} stillAlive={nextTeams === null || nextTeams.has(team.name)} />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // National rounds: index 4 = 4 regional champs, index 5 = 2 finalists, index 6 = champion
  const finalFourField = roundsHistory[4] ?? null;
  const finalistsField = revealedRounds >= 5 ? roundsHistory[5] : null;
  const championField = revealedRounds >= 6 ? roundsHistory[6] : null;

  return (
    <div className="rounded-lg border border-neutral-800 bg-black/40 p-4">
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        {regions.map((region) => (
          <RegionColumns key={region} region={region} />
        ))}
      </div>

      {finalFourField && finalFourField.length > 0 && (
        <div className="mt-5 border-t border-neutral-800 pt-4">
          <p className="mb-2 text-center text-[10px] font-bold uppercase tracking-widest text-yellow-400">
            Final Four{championField ? ' → Champion' : finalistsField ? ' → Championship' : ''}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4">
            {finalFourField.map((team) => {
              const stillIn = finalistsField ? finalistsField.some((t) => t.name === team.name) : true;
              const isChamp = championField ? championField[0]?.name === team.name : false;
              return (
                <div
                  key={team.name}
                  className={`rounded border px-3 py-1.5 text-xs ${
                    isChamp
                      ? 'border-yellow-400 bg-yellow-400/10 font-bold text-yellow-300'
                      : stillIn
                        ? 'border-neutral-700 text-neutral-200'
                        : 'border-neutral-900 text-neutral-600 line-through'
                  }`}
                >
                  #{team.seed} {team.name}
                  {isChamp && ' 🏆'}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
