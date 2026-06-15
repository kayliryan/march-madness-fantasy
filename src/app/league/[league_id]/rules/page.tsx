'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import AppHeader from '@/components/AppHeader';
import type { GetLeagueResponse, LeagueSettings } from '@/lib/types';

const POSITION_ORDER = ['G', 'F', 'C'] as const;
const POSITION_LABELS: Record<string, string> = { G: 'Guards', F: 'Forwards', C: 'Centers' };

const TIEBREAKER_LABELS: Record<string, string> = {
  highest_single_active_game: 'Highest single-game score by an active player',
};

function getRosterLine(settings: LeagueSettings): string {
  const parts = POSITION_ORDER
    .filter((pos) => settings.starter_slots[pos] !== undefined)
    .map((pos) => `${settings.starter_slots[pos]} ${POSITION_LABELS[pos]}`);
  return [...parts, `${settings.bench_slots} Bench`].join(' · ');
}

function getSubstitutionSentences(settings: LeagueSettings): string[] {
  const groups = new Map<string, string[]>();
  for (const [pos, eligible] of Object.entries(settings.sub_eligibility_matrix)) {
    if (eligible.length === 0) continue;
    const key = JSON.stringify([...eligible].sort());
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(pos);
  }
  for (const [key, positions] of groups) {
    groups.set(
      key,
      positions.sort((a, b) => POSITION_ORDER.indexOf(a as 'G' | 'F' | 'C') - POSITION_ORDER.indexOf(b as 'G' | 'F' | 'C'))
    );
  }

  const sentences: string[] = [];
  for (const [key, positions] of groups) {
    const eligible: string[] = JSON.parse(key);
    const posLabels = positions.map((p) => POSITION_LABELS[p]);
    const eligibleLabels = eligible.map((p) => POSITION_LABELS[p] ?? p);

    const posText = posLabels.join(' and ');
    const eligibleText = eligibleLabels.join(' or ');

    if (positions.length === 1 && eligible.length === 1 && positions[0] === eligible[0]) {
      sentences.push(`${posText} can only be replaced by ${eligibleText}`);
    } else {
      sentences.push(`${posText} can be replaced by ${eligibleText}`);
    }
  }
  return sentences;
}

function getBenchLockText(mode: LeagueSettings['bench_lock_mode']): string {
  return mode === 'before_first_game'
    ? 'Bench orders lock before the first game tips off'
    : 'Bench orders are always editable';
}

function getActivationText(timing: LeagueSettings['activation_timing']): string {
  return timing === 'immediate'
    ? "Bench players activate immediately when a starter's team is eliminated"
    : 'Bench players activate at the end of each round';
}

function getScoringText(includesPlayIn: boolean): string {
  return includesPlayIn ? 'Play-in games count toward scoring' : 'Play-in games do not count';
}

function getTiebreakerText(strategies: string[]): string {
  const strategy = strategies[0];
  return TIEBREAKER_LABELS[strategy] ?? `Unknown tiebreaker: ${strategy}`;
}

export default function LeagueRulesPage() {
  const params = useParams<{ league_id: string }>();
  const { league_id } = params;

  const [league, setLeague] = useState<GetLeagueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/league/${league_id}`)
      .then((res) => {
        if (res.status === 401) {
          window.location.href = '/auth/login';
          return null;
        }
        if (!res.ok) throw new Error('Failed to load league');
        return res.json();
      })
      .then((json: GetLeagueResponse | null) => {
        if (json) setLeague(json);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [league_id]);

  if (loading) {
    return (
      <div className="min-h-screen bg-black">
        <AppHeader leagueId={league_id} />
        <div className="flex items-center justify-center py-24">
          <p className="text-neutral-500">Loading rules…</p>
        </div>
      </div>
    );
  }

  if (error || !league) {
    return (
      <div className="min-h-screen bg-black">
        <AppHeader leagueId={league_id} />
        <div className="flex items-center justify-center py-24">
          <p className="text-red-400">{error ?? 'League not found.'}</p>
        </div>
      </div>
    );
  }

  const settings = league.league.settings;
  const rosterLine = getRosterLine(settings);
  const substitutionSentences = getSubstitutionSentences(settings);

  return (
    <div className="min-h-screen bg-black">
      <AppHeader leagueId={league_id} />

      <div className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-2xl font-bold text-white">League Rules</h1>
        <p className="mt-1 text-sm text-neutral-500">{league.league.name} · Season {league.league.season}</p>

        <div className="mt-6 space-y-4">
          <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Roster</h2>
            <p className="mt-2 text-sm text-neutral-300">{rosterLine}</p>
          </section>

          <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Substitutions</h2>
            <ul className="mt-2 space-y-1 text-sm text-neutral-300">
              {substitutionSentences.map((sentence) => (
                <li key={sentence}>{sentence}</li>
              ))}
            </ul>
          </section>

          <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Bench Lock</h2>
            <p className="mt-2 text-sm text-neutral-300">{getBenchLockText(settings.bench_lock_mode)}</p>
          </section>

          <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Activation</h2>
            <p className="mt-2 text-sm text-neutral-300">{getActivationText(settings.activation_timing)}</p>
          </section>

          <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Scoring</h2>
            <p className="mt-2 text-sm text-neutral-300">{getScoringText(settings.scoring_includes_play_in)}</p>
          </section>

          <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Tiebreaker</h2>
            <p className="mt-2 text-sm text-neutral-300">{getTiebreakerText(settings.tiebreaker_strategies)}</p>
          </section>
        </div>
      </div>
    </div>
  );
}
