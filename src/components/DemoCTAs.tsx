'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import { useDemoSession } from '@/lib/context/DemoSessionContext';

const buttonClass =
  'w-full rounded bg-yellow-400 px-8 py-4 text-base font-black uppercase tracking-wide text-black shadow-lg hover:bg-yellow-300 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto';
const linkClass =
  'w-full rounded border border-neutral-700 bg-transparent px-8 py-4 text-base font-bold uppercase tracking-wide text-neutral-300 hover:border-neutral-500 hover:text-white sm:w-auto';

// Section 14.9 — landing page CTAs. "Try as Commissioner" provisions a personal
// demo league (Section 14.3); on success the shared demoSession state swaps
// "View demo standings" for "Return to your league →".
export function DemoCTAs() {
  const router = useRouter();
  const { demoSession, setDemoSession } = useDemoSession();
  const [provisioning, setProvisioning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleTryAsCommissioner() {
    setProvisioning(true);
    setError(null);

    try {
      const res = await fetch('/api/demo/provision', { method: 'POST' });
      if (!res.ok) throw new Error('provision failed');
      const data = await res.json() as {
        league_id: string;
        draft_session_id: string;
        access_token: string;
        refresh_token: string;
        expires_at: string;
      };

      // Sync the browser Supabase client so it acts as the provisioned commissioner
      await supabase.auth.setSession({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
      });

      setDemoSession({
        access_token: data.access_token,
        expires_at: data.expires_at,
        league_id: data.league_id,
        draft_session_id: data.draft_session_id,
      });

      router.push(`/commissioner/${data.league_id}`);
    } catch {
      setError('Something went wrong — try again');
      setProvisioning(false);
    }
  }

  const provisioned = !!demoSession?.league_id;

  return (
    <div className="mt-10 flex flex-col items-center gap-4">
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
        <button
          onClick={handleTryAsCommissioner}
          disabled={provisioning || provisioned}
          className={buttonClass}
        >
          {provisioning ? 'Setting up your league...' : 'Try as Commissioner'}
        </button>
        <Link href="/demo/draft" className={linkClass}>
          Try mock draft — no sign-up
        </Link>
        {provisioned ? (
          <Link href={`/commissioner/${demoSession.league_id}`} className={linkClass}>
            Return to your league →
          </Link>
        ) : (
          <Link href="/demo/league" className={linkClass}>
            View demo standings
          </Link>
        )}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
