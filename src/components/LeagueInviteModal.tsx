'use client';

import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface LeagueInviteModalProps {
  leagueId: string;
  leagueName: string;
  onClose: () => void;
}

interface SentInvite {
  email: string;
  status: 'sending' | 'sent' | 'error';
}

export function LeagueInviteModal({ leagueId, leagueName, onClose }: LeagueInviteModalProps) {
  const [email, setEmail] = useState('');
  const [invites, setInvites] = useState<SentInvite[]>([]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;

    setInvites((prev) => [...prev, { email: trimmed, status: 'sending' }]);
    setEmail('');

    try {
      const res = await fetch('/api/league/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ league_id: leagueId, email: trimmed }),
      });
      const status: SentInvite['status'] = res.ok ? 'sent' : 'error';
      setInvites((prev) =>
        prev.map((inv) => (inv.email === trimmed ? { ...inv, status } : inv))
      );
    } catch {
      setInvites((prev) =>
        prev.map((inv) => (inv.email === trimmed ? { ...inv, status: 'error' } : inv))
      );
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Invite friends</h2>
            <p className="text-sm text-gray-500">{leagueName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="size-5" />
          </button>
        </div>

        <form onSubmit={handleInvite} className="flex gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="friend@example.com"
            className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none"
          />
          <Button type="submit">Send</Button>
        </form>

        {invites.length > 0 && (
          <ul className="mt-4 flex flex-col gap-1.5">
            {invites.map((inv, i) => (
              <li
                key={`${inv.email}-${i}`}
                className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 text-sm"
              >
                <span className="truncate text-gray-700">{inv.email}</span>
                {inv.status === 'sent' ? (
                  <span className="flex items-center gap-1 text-green-600">
                    <Check className="size-4" /> Sent
                  </span>
                ) : inv.status === 'error' ? (
                  <span className="text-red-600">Failed</span>
                ) : (
                  <span className="text-gray-400">Sending…</span>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-6 flex justify-end">
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
