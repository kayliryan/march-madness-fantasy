'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import { useDemoSession } from '@/lib/context/DemoSessionContext';

type FailureMode = 'capacity' | 'rate_limited' | 'network';

function ProvisionError({ mode }: { mode: FailureMode }) {
  const fallback = (
    <Link href="/demo/league" className="underline hover:text-yellow-400">
      view a completed season instead
    </Link>
  );

  if (mode === 'capacity') {
    return (
      <p className="text-sm text-neutral-400">
        {"We're at capacity for live demos right now. Try again in a moment, or "}
        {fallback}.
      </p>
    );
  }
  if (mode === 'rate_limited') {
    return (
      <p className="text-sm text-neutral-400">
        {"You've reached the demo limit for your network today. You can still "}
        {fallback}.
      </p>
    );
  }
  return (
    <p className="text-sm text-neutral-400">
      Something went wrong —{' '}
      <button
        onClick={() => window.location.reload()}
        className="underline hover:text-yellow-400"
      >
        try again
      </button>
      , or {fallback}.
    </p>
  );
}

// Dashboard-shaped skeleton shown while the league provisions.
// Gives visitors a sense of what they're about to land in rather than a blank wait.
function ProvisioningSkeleton() {
  return (
    <div className="mt-6 w-full max-w-xl mx-auto rounded-lg border border-neutral-800 bg-[#0d0d0d] p-5 text-left">
      {/* Page header */}
      <div className="mb-4 h-4 w-32 animate-pulse rounded bg-neutral-800" />
      <div className="mb-6 h-7 w-48 animate-pulse rounded bg-neutral-700" />
      {/* Two section cards */}
      {[48, 36].map((h, i) => (
        <div key={i} className="mb-3 rounded border border-neutral-800 bg-neutral-900 p-4">
          <div className="mb-3 h-3 w-28 animate-pulse rounded bg-neutral-800" />
          <div
            className="animate-pulse rounded bg-neutral-800"
            style={{ height: h }}
          />
        </div>
      ))}
      <p className="mt-3 text-center text-xs text-neutral-600">
        Setting up your commissioner league…
      </p>
    </div>
  );
}

export function DemoCTAs() {
  const router = useRouter();
  const { demoSession, setDemoSession } = useDemoSession();
  const [provisioning, setProvisioning] = useState(false);
  const [failure, setFailure] = useState<FailureMode | null>(null);

  async function handleTryAsCommissioner() {
    setProvisioning(true);
    setFailure(null);

    try {
      const res = await fetch('/api/demo/provision', { method: 'POST' });

      if (res.status === 429) {
        const body = await res.json() as { errorCode?: string };
        setFailure(body.errorCode === 'RATE_LIMIT_IP' ? 'rate_limited' : 'capacity');
        setProvisioning(false);
        return;
      }

      if (!res.ok) {
        setFailure('network');
        setProvisioning(false);
        return;
      }

      const data = await res.json() as {
        league_id: string;
        draft_session_id: string;
        access_token: string;
        refresh_token: string;
        expires_at: string;
      };

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
      setFailure('network');
      setProvisioning(false);
    }
  }

  const provisioned = !!demoSession?.league_id;

  return (
    <div className="mt-10 flex flex-col items-center gap-3">
      {provisioned ? (
        <Link
          href={`/commissioner/${demoSession.league_id}`}
          className="w-full rounded bg-yellow-400 px-8 py-4 text-base font-black uppercase tracking-wide text-black shadow-lg hover:bg-yellow-300 sm:w-auto"
        >
          Return to your league →
        </Link>
      ) : (
        <button
          onClick={handleTryAsCommissioner}
          disabled={provisioning}
          className="w-full rounded bg-yellow-400 px-8 py-4 text-base font-black uppercase tracking-wide text-black shadow-lg hover:bg-yellow-300 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
        >
          {provisioning ? 'Setting up your league…' : 'Try mock draft as a commissioner — no signup'}
        </button>
      )}

      {provisioning && <ProvisioningSkeleton />}
      {failure && <ProvisionError mode={failure} />}
    </div>
  );
}
