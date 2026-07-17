'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { CURRENT_TOURNAMENT_SEASON } from '@/lib/constants/season';
import type { CreateLeagueRequest, LeagueSettings } from '@/lib/types';

interface LeagueFormProps {
  onSubmit: (payload: CreateLeagueRequest) => Promise<void>;
  submitting?: boolean;
  season: number;
}

export function LeagueForm({ onSubmit, submitting = false, season }: LeagueFormProps) {
  const [name, setName] = useState('');
  const [draftType, setDraftType] = useState<LeagueSettings['draft_type']>('snake');
  const [pickTimer, setPickTimer] = useState(90);
  const [starterG, setStarterG] = useState(2);
  const [starterF, setStarterF] = useState(2);
  const [starterC, setStarterC] = useState(1);
  const [benchSlots, setBenchSlots] = useState(3);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!name.trim()) {
      setFormError('League name is required.');
      return;
    }

    const settings: Partial<LeagueSettings> = {
      draft_type: draftType,
      pick_timer_seconds: pickTimer,
      starter_slots: { G: starterG, F: starterF, C: starterC },
      bench_slots: benchSlots,
    };

    await onSubmit({ name: name.trim(), season, settings });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="league-name" className="text-sm font-medium text-neutral-300">
          League name
        </label>
        <input
          id="league-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="The Office Bracket Brawl"
          className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:border-yellow-400 focus:outline-none"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-neutral-300">Season</label>
          <div className="flex items-center rounded-md border border-neutral-800 bg-neutral-800/50 px-3 py-2">
            <span className="text-sm text-white">{season}</span>
            <span className="ml-2 text-xs text-neutral-500">
              {season === CURRENT_TOURNAMENT_SEASON ? '(Active)' : '(Upcoming)'}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="draft-type" className="text-sm font-medium text-neutral-300">
            Draft type
          </label>
          <select
            id="draft-type"
            value={draftType}
            onChange={(e) => setDraftType(e.target.value as LeagueSettings['draft_type'])}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:border-yellow-400 focus:outline-none"
          >
            <option value="snake">Snake</option>
            <option value="linear">Linear</option>
            <option value="auction">Auction</option>
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="pick-timer" className="text-sm font-medium text-neutral-300">
          Pick timer (seconds)
        </label>
        <input
          id="pick-timer"
          type="number"
          min={15}
          value={pickTimer}
          onChange={(e) => setPickTimer(Number(e.target.value))}
          className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:border-yellow-400 focus:outline-none"
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-neutral-300">Starter slots</legend>
        <div className="grid grid-cols-3 gap-4">
          {(
            [
              ['Guards', starterG, setStarterG],
              ['Forwards', starterF, setStarterF],
              ['Centers', starterC, setStarterC],
            ] as const
          ).map(([label, value, setter]) => (
            <div key={label} className="flex flex-col gap-1.5">
              <label className="text-xs text-neutral-500">{label}</label>
              <input
                type="number"
                min={0}
                value={value}
                onChange={(e) => setter(Number(e.target.value))}
                className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:border-yellow-400 focus:outline-none"
              />
            </div>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="bench-slots" className="text-sm font-medium text-neutral-300">
          Bench slots
        </label>
        <input
          id="bench-slots"
          type="number"
          min={0}
          value={benchSlots}
          onChange={(e) => setBenchSlots(Number(e.target.value))}
          className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:border-yellow-400 focus:outline-none"
        />
      </div>

      {formError && <p className="text-sm text-red-400">{formError}</p>}

      <Button type="submit" size="lg" disabled={submitting}>
        {submitting ? 'Creating…' : 'Create League'}
      </Button>
    </form>
  );
}
