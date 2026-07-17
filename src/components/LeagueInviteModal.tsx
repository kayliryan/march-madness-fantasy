'use client';

import { useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface LeagueInviteModalProps {
  leagueId: string;
  leagueName: string;
  onClose: () => void;
}

interface SentInvite {
  email: string;
  status: 'sending' | 'sent' | 'error';
  // Demo leagues: email suppressed; invite_url is the real, working link.
  email_stub?: boolean;
  invite_url?: string;
}

function CopyLinkRow({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(url).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="mt-1">
      <p className="mb-1.5 text-xs text-neutral-400">
        Invite link generated — email delivery is simulated in demo mode. Copy the link below to
        test joining as a second member.
      </p>
      <div className="flex items-center gap-2 rounded-md bg-neutral-900 border border-neutral-700 px-2 py-1.5">
        <span className="flex-1 truncate text-xs text-neutral-400">{url}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="shrink-0 text-neutral-400 hover:text-yellow-400"
          aria-label="Copy invite link"
        >
          {copied ? <Check className="size-4 text-green-400" /> : <Copy className="size-4" />}
        </button>
      </div>
    </div>
  );
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

      if (res.ok) {
        const data = await res.json() as { email_stub?: boolean; invite_url?: string };
        setInvites((prev) =>
          prev.map((inv) =>
            inv.email === trimmed
              ? { ...inv, status: 'sent', email_stub: data.email_stub, invite_url: data.invite_url }
              : inv
          )
        );
      } else {
        setInvites((prev) =>
          prev.map((inv) => (inv.email === trimmed ? { ...inv, status: 'error' } : inv))
        );
      }
    } catch {
      setInvites((prev) =>
        prev.map((inv) => (inv.email === trimmed ? { ...inv, status: 'error' } : inv))
      );
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-xl font-bold text-white">Invite friends</h2>
            <p className="text-sm text-neutral-500">{leagueName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
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
            className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:border-yellow-400 focus:outline-none"
          />
          <Button type="submit">Send</Button>
        </form>

        {invites.length > 0 && (
          <ul className="mt-4 flex flex-col gap-2">
            {invites.map((inv, i) => (
              <li
                key={`${inv.email}-${i}`}
                className="rounded-md bg-neutral-800 px-3 py-2 text-sm"
              >
                <div className="flex items-center justify-between">
                  <span className="truncate text-neutral-300">{inv.email}</span>
                  {inv.status === 'sent' && !inv.email_stub ? (
                    <span className="flex items-center gap-1 text-green-400">
                      <Check className="size-4" /> Sent
                    </span>
                  ) : inv.status === 'error' ? (
                    <span className="text-red-400">Failed</span>
                  ) : inv.status === 'sending' ? (
                    <span className="text-neutral-500">Sending…</span>
                  ) : null}
                </div>
                {inv.email_stub && inv.invite_url && (
                  <CopyLinkRow url={inv.invite_url} />
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
