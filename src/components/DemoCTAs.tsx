'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import {
  useDemoSession,
  readStoredDemoLeague,
  writeStoredDemoLeague,
  clearStoredDemoLeague,
} from '@/lib/context/DemoSessionContext';

type FailureMode = 'capacity' | 'rate_limited' | 'network';

// Always-visible secondary path (Section 1 / Section 7): the static demo
// standings page requires no provisioning and is the universal fallback, so
// it must be reachable from idle, loading, welcome-back, and failure states.
function ViewCompletedSeasonLink() {
  return (
    <Link href="/demo/league" className="text-xs text-neutral-500 underline hover:text-neutral-300">
      Just want to see the data? View a completed season
    </Link>
  );
}

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
  // True until the mount-time restore check (below) resolves. While true, the
  // primary button keeps its normal idle copy — never a distinct "checking…"
  // state — but stays disabled so a click can't race the restore and fire a
  // second, redundant provision call.
  const [checkingRestore, setCheckingRestore] = useState(true);

  // On mount: if a previous provision left a league_id in localStorage,
  // re-validate it against the server before trusting it — the anonymous
  // session and/or the league itself may no longer exist (TTL cleanup,
  // browser data cleared, cookies expired). Only on both checks passing do we
  // surface the "welcome back" state; any failure clears the stale value and
  // falls through to the normal provision CTA.
  useEffect(() => {
    let cancelled = false;

    async function restore() {
      const stored = readStoredDemoLeague();
      if (!stored) {
        setCheckingRestore(false);
        return;
      }

      try {
        const [{ data: userData }, { data: sessionData }] = await Promise.all([
          supabase.auth.getUser(),
          supabase.auth.getSession(),
        ]);

        const user = userData.user;
        if (!user || !user.is_anonymous) {
          clearStoredDemoLeague();
          if (!cancelled) setCheckingRestore(false);
          return;
        }

        const res = await fetch(`/api/league/${stored.league_id}`);
        if (!res.ok) {
          // 401 (session expired), 403 (not a member), 404 (league cleaned
          // up by TTL) all mean the stored value no longer points at
          // anything usable.
          clearStoredDemoLeague();
          if (!cancelled) setCheckingRestore(false);
          return;
        }

        if (!cancelled) {
          const session = sessionData.session;
          setDemoSession({
            access_token: session?.access_token ?? '',
            expires_at: session?.expires_at
              ? new Date(session.expires_at * 1000).toISOString()
              : new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            league_id: stored.league_id,
            draft_session_id: stored.draft_session_id,
          });
          setCheckingRestore(false);
        }
      } catch {
        clearStoredDemoLeague();
        if (!cancelled) setCheckingRestore(false);
      }
    }

    restore();
    return () => {
      cancelled = true;
    };
  }, [setDemoSession]);

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

      // Persist so a later refresh (or return visit to `/`) restores this
      // league instead of silently provisioning a second one — see the
      // restore effect above and the comment on readStoredDemoLeague.
      writeStoredDemoLeague({
        league_id: data.league_id,
        draft_session_id: data.draft_session_id,
      });

      router.push(`/commissioner/${data.league_id}`);
    } catch {
      setFailure('network');
      setProvisioning(false);
    }
  }

  function handleStartFresh() {
    clearStoredDemoLeague();
    setDemoSession(null);
  }

  const provisioned = !!demoSession?.league_id;

  return (
    <div className="mt-10 flex flex-col items-center gap-3">
      {provisioned ? (
        <>
          <Link
            href={`/commissioner/${demoSession.league_id}`}
            className="w-full rounded bg-yellow-400 px-8 py-4 text-base font-black uppercase tracking-wide text-black shadow-lg hover:bg-yellow-300 sm:w-auto"
          >
            Return to your demo league →
          </Link>
          <button
            onClick={handleStartFresh}
            className="text-xs text-neutral-500 underline hover:text-neutral-300"
          >
            Start a fresh demo
          </button>
        </>
      ) : (
        <button
          onClick={handleTryAsCommissioner}
          disabled={provisioning || checkingRestore}
          className="w-full rounded bg-yellow-400 px-8 py-4 text-base font-black uppercase tracking-wide text-black shadow-lg hover:bg-yellow-300 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
        >
          {provisioning ? 'Setting up your league…' : 'Explore as Commissioner — see everything, no signup.'}
        </button>
      )}

      {/* Failure states already surface their own "view a completed season"
          fallback link inline (Section 7); avoid showing it twice. */}
      {!failure && <ViewCompletedSeasonLink />}

      {provisioning && <ProvisioningSkeleton />}
      {failure && <ProvisionError mode={failure} />}
    </div>
  );
}
