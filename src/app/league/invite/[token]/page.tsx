'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase/client';
import type { GetInviteByTokenResponse } from '@/lib/types';

export default function InviteAcceptPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const { token } = params;

  const [invite, setInvite] = useState<GetInviteByTokenResponse['invite'] | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch(`/api/league/invite?token=${encodeURIComponent(token)}`),
      supabase.auth.getUser(),
    ])
      .then(async ([res, { data }]) => {
        setIsAuthenticated(!!data.user);
        if (!res.ok) {
          throw new Error(res.status === 404 ? 'This invite link is invalid.' : 'Failed to load invite.');
        }
        const json: GetInviteByTokenResponse = await res.json();
        setInvite(json.invite);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [token]);

  async function handleAccept() {
    setAccepting(true);
    setAcceptError(null);
    try {
      const res = await fetch(`/api/league/invite/${token}/accept`, { method: 'POST' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? 'Failed to accept invite.');
      }
      const json = await res.json();
      router.push(`/league/${json.league_member.league_id}`);
    } catch (err) {
      setAcceptError(err instanceof Error ? err.message : 'Failed to accept invite.');
      setAccepting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black">
        <p className="text-neutral-500">Loading invite…</p>
      </div>
    );
  }

  if (error || !invite) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black px-4">
        <div className="w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-900 p-6 text-center">
          <h1 className="mb-2 text-lg font-bold text-white">Invite Not Found</h1>
          <p className="text-sm text-neutral-400">{error ?? 'This invite link is invalid.'}</p>
          <Link href="/" className="mt-4 inline-block text-sm text-yellow-400 hover:underline">
            Back to home
          </Link>
        </div>
      </div>
    );
  }

  const isExpired = invite.status === 'expired' || new Date(invite.expires_at) < new Date();
  const leagueName = invite.leagues?.name ?? 'a league';
  const invitedByName = invite.users?.display_name ?? 'Someone';

  return (
    <div className="flex min-h-screen items-center justify-center bg-black px-4">
      <div className="w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-sm">
        <p className="text-xs font-extrabold uppercase tracking-wide text-yellow-400">
          March Madness Fantasy
        </p>
        <h1 className="mt-2 text-xl font-bold text-white">You&apos;re invited!</h1>
        <p className="mt-3 text-sm text-neutral-300">
          <span className="font-semibold text-white">{invitedByName}</span> invited you to join{' '}
          <span className="font-semibold text-white">{leagueName}</span>
          {invite.leagues?.season ? ` (Season ${invite.leagues.season})` : ''}.
        </p>
        <p className="mt-1 text-sm text-neutral-500">Invited email: {invite.invited_email}</p>

        {invite.status === 'accepted' ? (
          <div className="mt-5 rounded-md border border-yellow-400/30 bg-yellow-400/10 px-3 py-2 text-sm text-yellow-300">
            This invite has already been accepted.
          </div>
        ) : isExpired ? (
          <div className="mt-5 rounded-md border border-yellow-400/30 bg-yellow-400/10 px-3 py-2 text-sm text-yellow-300">
            This invite has expired. Ask the commissioner to send a new one.
          </div>
        ) : isAuthenticated === false ? (
          <div className="mt-5 space-y-3">
            <p className="text-sm text-neutral-400">Sign in or create an account to accept this invite.</p>
            <div className="flex gap-3">
              <Link
                href="/auth/login"
                className="flex-1 rounded-md bg-yellow-400 px-4 py-2 text-center text-sm font-semibold text-black hover:bg-yellow-300"
              >
                Sign in
              </Link>
              <Link
                href="/auth/signup"
                className="flex-1 rounded-md border border-neutral-700 px-4 py-2 text-center text-sm font-semibold text-white hover:border-yellow-400/40 hover:text-yellow-400"
              >
                Sign up
              </Link>
            </div>
            <p className="text-xs text-neutral-500">
              After signing in, return to this page using the link from your invite email.
            </p>
          </div>
        ) : (
          <div className="mt-5">
            <button
              onClick={handleAccept}
              disabled={accepting}
              className="w-full rounded-md bg-yellow-400 px-4 py-2 text-sm font-semibold text-black hover:bg-yellow-300 disabled:opacity-50"
            >
              {accepting ? 'Accepting…' : 'Accept Invite'}
            </button>
            {acceptError && (
              <p className="mt-2 text-sm text-red-400">{acceptError}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
