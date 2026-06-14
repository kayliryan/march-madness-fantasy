'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

interface DraftSchedulerProps {
  initialScheduledStart?: string | null;
  initialPickTimerSeconds?: number | null;
  onSave: (params: { scheduled_start: string; pick_timer_seconds: number }) => Promise<void>;
  saving?: boolean;
  // Demo leagues set scheduled_start to now()-1min so Start Draft is immediately
  // available — hide the field so the commissioner can't accidentally invalidate it.
  showScheduledStart?: boolean;
}

// Converts an ISO timestamp to the value format a datetime-local input expects
function toLocalInputValue(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function DraftScheduler({
  initialScheduledStart,
  initialPickTimerSeconds,
  onSave,
  saving = false,
  showScheduledStart = true,
}: DraftSchedulerProps) {
  const [scheduledStart, setScheduledStart] = useState(toLocalInputValue(initialScheduledStart));
  const [pickTimer, setPickTimer] = useState(initialPickTimerSeconds ?? 90);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    if (showScheduledStart && !scheduledStart) {
      setError('Please choose a draft date and time.');
      return;
    }
    // datetime-local has no timezone; interpret as local and convert to ISO
    await onSave({
      scheduled_start: new Date(scheduledStart).toISOString(),
      pick_timer_seconds: pickTimer,
    });
  }

  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-5 shadow-sm">
      <h3 className="mb-3 text-lg font-semibold text-white">Draft Schedule</h3>

      <div className="mb-4 flex flex-col gap-4 sm:flex-row">
        {showScheduledStart && (
          <div className="flex flex-1 flex-col gap-1.5">
            <label htmlFor="scheduled-start" className="text-sm font-medium text-neutral-300">
              Date &amp; time
            </label>
            <input
              id="scheduled-start"
              type="datetime-local"
              value={scheduledStart}
              onChange={(e) => setScheduledStart(e.target.value)}
              className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:border-yellow-400 focus:outline-none"
            />
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="pick-timer-sched" className="text-sm font-medium text-neutral-300">
            Pick timer (s)
          </label>
          <input
            id="pick-timer-sched"
            type="number"
            min={15}
            value={pickTimer}
            onChange={(e) => setPickTimer(Number(e.target.value))}
            className="w-28 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:border-yellow-400 focus:outline-none"
          />
        </div>
      </div>

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

      <Button onClick={handleSave} disabled={saving}>
        {saving ? 'Saving…' : 'Save Schedule'}
      </Button>
    </section>
  );
}
