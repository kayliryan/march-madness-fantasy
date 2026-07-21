'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { supabase } from '@/lib/supabase/client';
import {
  useDemoSession,
  readStoredDemoLeague,
  writeStoredDemoLeague,
  clearStoredDemoLeague,
} from '@/lib/context/DemoSessionContext';

type FailureMode = 'capacity' | 'rate_limited' | 'network';

// Bordered amber banner — the same visual language as the "demo league" and
// "getting started" notices on the commissioner page (border-yellow-400/30 +
// bg-yellow-400/10). A 429/error is a real state change, not a footnote, so it
// gets a card + icon instead of a muted line of text easy to miss below the
// button.
function ProvisionError({ mode }: { mode: FailureMode }) {
  const fallback = (
    <Link href="/demo/league" className="underline hover:text-yellow-200">
      view a completed season instead
    </Link>
  );

  let message: ReactNode;
  if (mode === 'capacity') {
    message = (
      <>
        {"We're at capacity for live demos right now. Try again in a moment, or "}
        {fallback}.
      </>
    );
  } else if (mode === 'rate_limited') {
    message = (
      <>
        {"You've reached the demo limit for your network today. You can still "}
        {fallback}.
      </>
    );
  } else {
    message = (
      <>
        Something went wrong —{' '}
        <button
          onClick={() => window.location.reload()}
          className="underline hover:text-yellow-200"
        >
          try again
        </button>
        , or {fallback}.
      </>
    );
  }

  return (
    <div className="mt-2 flex w-full items-start gap-3 rounded-lg border border-yellow-400/30 bg-yellow-400/10 p-4 text-left">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-yellow-400" aria-hidden="true" />
      <p className="text-sm text-yellow-100">{message}</p>
    </div>
  );
}

// Dashboard-shaped skeleton shown while the league provisions.
// Gives visitors a sense of what they're about to land in rather than a blank wait.
function ProvisioningSkeleton() {
  return (
    <div className="mt-4 w-full rounded-lg border border-neutral-800 bg-neutral-950 p-5 text-left">
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

  // On mount: if a previous provision left a league_id in localStorage,
  // re-validate it against the server before trusting it — the anonymous
  // session and/or the league itself may no longer exist (TTL cleanup,
  // browser data cleared, cookies expired). Only on both checks passing do we
  // surface the "welcome back" state; any failure clears the stale value and
  // falls through to the normal provision CTA.
  //
  // This runs fully in the background: the primary button renders in its
  // normal clickable idle state immediately and is never gated on this
  // check resolving (a stale stored league_id can mean a slow round trip —
  // network calls plus a cold API route — and a disabled button waiting on
  // that is a worse experience than the rare double-click race where a user
  // clicks before this resolves). If it resolves to a valid prior league,
  // the button swaps to the "Return to your demo league" state after the
  // fact.
  useEffect(() => {
    let cancelled = false;

    async function restore() {
      const stored = readStoredDemoLeague();
      if (!stored) return;

      try {
        const [{ data: userData }, { data: sessionData }] = await Promise.all([
          supabase.auth.getUser(),
          supabase.auth.getSession(),
        ]);

        const user = userData.user;
        if (!user || !user.is_anonymous) {
          clearStoredDemoLeague();
          return;
        }

        const res = await fetch(`/api/league/${stored.league_id}`);
        if (!res.ok) {
          // 401 (session expired), 403 (not a member), 404 (league cleaned
          // up by TTL) all mean the stored value no longer points at
          // anything usable.
          clearStoredDemoLeague();
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
        }
      } catch {
        clearStoredDemoLeague();
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
    <div className="mt-5 flex flex-col items-stretch gap-3">
      {provisioned ? (
        <>
          <Link
            href={`/commissioner/${demoSession.league_id}`}
            className="w-full rounded bg-yellow-400 px-4 py-3 text-center text-sm font-black uppercase tracking-wide text-black shadow-lg hover:bg-yellow-300"
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
          disabled={provisioning}
          className={`w-full rounded px-4 py-3 text-sm font-black uppercase tracking-wide shadow-lg disabled:cursor-not-allowed disabled:opacity-50 ${
            failure
              ? 'bg-neutral-900 text-yellow-400 ring-2 ring-yellow-400/50 hover:bg-neutral-800'
              : 'bg-yellow-400 text-black hover:bg-yellow-300'
          }`}
        >
          {provisioning
            ? 'Setting up your league…'
            : failure
              ? 'Try again'
              : 'Enter the completed league →'}
        </button>
      )}

      {provisioning && <ProvisioningSkeleton />}
      {failure && <ProvisionError mode={failure} />}
    </div>
  );
}
