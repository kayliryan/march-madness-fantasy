import type { Player } from '@/lib/types';

interface TeamBadgeProps {
  team: NonNullable<Player['teams']>;
}

export function TeamBadge({ team }: TeamBadgeProps) {
  return (
    <span className="inline-flex items-center rounded-full border border-yellow-400/30 bg-yellow-400/10 px-2 py-0.5 text-xs font-semibold text-yellow-400">
      {team.name} #{team.seed}
    </span>
  );
}
