'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { format } from 'date-fns';
import { supabase } from '@/lib/supabase/client';
import AppHeader from '@/components/AppHeader';
import { DraftOrderGenerator } from '@/components/DraftOrderGenerator';
import { DraftScheduler } from '@/components/DraftScheduler';
import { PlayerPositionOverride } from '@/components/PlayerPositionOverride';
import { BenchOrderOverride } from '@/components/BenchOrderOverride';
import type {
  DraftPick,
  DraftSession,
  GetInvitesResponse,
  GetLeagueResponse,
  GetPlayersResponse,
  InviteListItem,
  League,
  LeagueMember,
  Player,
  UpdateMemberRoleResponse,
} from '@/lib/types';

const ROUND_STAGES = ['play_in', 'r64', 'r32', 's16', 'e8', 'f4', 'championship'] as const;
const ROUND_STAGE_LABELS: Record<string, string> = {
  play_in: 'Play-In',
  r64: 'Round of 64',
  r32: 'Round of 32',
  s16: 'Sweet 16',
  e8: 'Elite 8',
  f4: 'Final Four',
  championship: 'Championship',
};

const ROLE_LABELS: Record<LeagueMember['role'], string> = {
  commissioner: 'Commissioner',
  co_commissioner: 'Co-Commissioner',
  member: 'Member',
};

export default function CommissionerPage() {
  const params = useParams<{ league_id: string }>();
  const leagueId = params.league_id;
  const router = useRouter();

  const [league, setLeague] = useState<League | null>(null);
  const [members, setMembers] = useState<LeagueMember[]>([]);
  const [memberLabels, setMemberLabels] = useState<Record<string, string>>({});
  const [currentMember, setCurrentMember] = useState<LeagueMember | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [draftSession, setDraftSession] = useState<DraftSession | null>(null);

  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [demoBannerDismissed, setDemoBannerDismissed] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [startingDraft, setStartingDraft] = useState(false);
  const [startDraftError, setStartDraftError] = useState<string | null>(null);

  // League settings state
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSuccess, setSettingsSuccess] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  // Pick void state
  const [voidPickNumber, setVoidPickNumber] = useState('');
  const [voidReason, setVoidReason] = useState('');
  const [replacementSearch, setReplacementSearch] = useState('');
  const [replacementId, setReplacementId] = useState('');
  const [voidError, setVoidError] = useState<string | null>(null);
  const [voidSuccess, setVoidSuccess] = useState<string | null>(null);
  const [voidingPick, setVoidingPick] = useState(false);

  // Correct a Pick (3-step) state
  const [correctPicks, setCorrectPicks] = useState<DraftPick[]>([]);
  const [correctDisplayNames, setCorrectDisplayNames] = useState<Record<string, string>>({});
  const [correctPicksLoading, setCorrectPicksLoading] = useState(true);
  const [correctStep, setCorrectStep] = useState<1 | 2 | 3>(1);
  const [selectedPick, setSelectedPick] = useState<DraftPick | null>(null);
  const [correctAvailable, setCorrectAvailable] = useState<Player[]>([]);
  const [correctAvailableLoading, setCorrectAvailableLoading] = useState(false);
  const [correctSearch, setCorrectSearch] = useState('');
  const [correctReplacementId, setCorrectReplacementId] = useState('');
  const [correctVoidReason, setCorrectVoidReason] = useState('');
  const [correctError, setCorrectError] = useState<string | null>(null);
  const [correctSuccess, setCorrectSuccess] = useState<string | null>(null);
  const [correctSubmitting, setCorrectSubmitting] = useState(false);

  // Manual score entry state
  const [scorePlayerId, setScorePlayerId] = useState('');
  const [scorePlayerSearch, setScorePlayerSearch] = useState('');
  const [scoreRoundStage, setScoreRoundStage] = useState<typeof ROUND_STAGES[number]>('r64');
  const [scoreRoundNumber, setScoreRoundNumber] = useState(1);
  const [scoreGameDate, setScoreGameDate] = useState('');
  const [scorePoints, setScorePoints] = useState('');
  const [scoreError, setScoreError] = useState<string | null>(null);
  const [scoreSuccess, setScoreSuccess] = useState(false);
  const [savingScore, setSavingScore] = useState(false);

  // Injury sub state
  const [injuredPlayerId, setInjuredPlayerId] = useState('');
  const [injuredPlayerSearch, setInjuredPlayerSearch] = useState('');
  const [subPlayerId, setSubPlayerId] = useState('');
  const [subPlayerSearch, setSubPlayerSearch] = useState('');
  const [injuryError, setInjuryError] = useState<string | null>(null);
  const [injurySuccess, setInjurySuccess] = useState<string | null>(null);
  const [savingInjurySub, setSavingInjurySub] = useState(false);

  // League Members & Invites state
  const [invites, setInvites] = useState<InviteListItem[]>([]);
  const [showExpiredInvites, setShowExpiredInvites] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteSending, setInviteSending] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);
  const [resendingToken, setResendingToken] = useState<string | null>(null);
  const [cancelingToken, setCancelingToken] = useState<string | null>(null);

  // Member role management state
  const [roleChangingUserId, setRoleChangingUserId] = useState<string | null>(null);
  const [memberActionError, setMemberActionError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<LeagueMember | null>(null);
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);

      const leagueRes = await fetch(`/api/league/${leagueId}`);
      if (leagueRes.status === 401) {
        router.push('/auth/login');
        return;
      }
      if (!leagueRes.ok) {
        setForbidden(true);
        setLoading(false);
        return;
      }

      const leagueData: GetLeagueResponse = await leagueRes.json();

      const role = leagueData.current_member.role;
      if (role !== 'commissioner' && role !== 'co_commissioner') {
        setForbidden(true);
        setLoading(false);
        return;
      }

      setLeague(leagueData.league);
      setMembers(leagueData.members);
      setCurrentMember(leagueData.current_member);

      // Member display names for labels (best-effort; falls back to id)
      const userIds = leagueData.members.map((m) => m.user_id);
      const { data: users } = await supabase
        .from('users')
        .select('id, display_name')
        .in('id', userIds);
      if (users) {
        setMemberLabels(
          Object.fromEntries(users.map((u) => [u.id, u.display_name]))
        );
      }

      // Player pool for the position-override tool
      const playersRes = await fetch('/api/players?sort=name');
      if (playersRes.ok) {
        const playersData: GetPlayersResponse = await playersRes.json();
        setPlayers(playersData.players);
      }

      // Existing draft session to prefill schedule/order
      const { data: session } = await supabase
        .from('draft_sessions')
        .select('*')
        .eq('league_id', leagueId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (session) setDraftSession(session as DraftSession);

      setLoading(false);
    }

    load();
  }, [leagueId, router]);

  async function handleSaveOrder(orderedUserIds: string[]) {
    if (!league) return;
    setSavingOrder(true);
    try {
      const res = await fetch('/api/commissioner/draft/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ league_id: leagueId, order: orderedUserIds }),
      });
      if (res.ok) {
        const data = await res.json();
        setDraftSession(data.draft_session as DraftSession);
      }
    } finally {
      setSavingOrder(false);
    }
  }

  async function handleSaveSchedule(p: { scheduled_start: string; pick_timer_seconds: number }) {
    if (!league) return;
    setSavingSchedule(true);
    try {
      const res = await fetch('/api/draft/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ league_id: leagueId, season: league.season, ...p }),
      });
      if (res.ok) {
        const data = await res.json();
        setDraftSession(data.draft_session as DraftSession);
      }
    } finally {
      setSavingSchedule(false);
    }
  }

  async function handleManualScore(e: React.FormEvent) {
    e.preventDefault();
    if (!scorePlayerId) { setScoreError('Select a player.'); return; }
    const pts = parseInt(scorePoints, 10);
    if (isNaN(pts) || pts < 0) { setScoreError('Points must be a non-negative number.'); return; }
    setScoreError(null);
    setScoreSuccess(false);
    setSavingScore(true);
    try {
      const res = await fetch(`/api/league/${leagueId}/scores/manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          player_id: scorePlayerId,
          round_stage: scoreRoundStage,
          round_number: scoreRoundNumber,
          game_date: scoreGameDate,
          points: pts,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        setScoreError(err.error ?? 'Failed to save score');
      } else {
        setScoreSuccess(true);
        setScorePlayerId('');
        setScorePlayerSearch('');
        setScorePoints('');
        setScoreGameDate('');
      }
    } finally {
      setSavingScore(false);
    }
  }

  async function handleInjurySub(e: React.FormEvent) {
    e.preventDefault();
    if (!injuredPlayerId) { setInjuryError('Select the injured player.'); return; }
    setInjuryError(null);
    setInjurySuccess(null);
    setSavingInjurySub(true);
    try {
      const body: Record<string, string> = { league_id: leagueId, injured_player_id: injuredPlayerId };
      if (subPlayerId) body.sub_player_id = subPlayerId;
      const res = await fetch('/api/commissioner/injury-sub', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        setInjuryError(err.error ?? 'Failed to process injury sub');
      } else {
        const data = await res.json();
        const subName = players.find((p) => p.id === data.sub_player_id)?.name ?? data.sub_player_id;
        setInjurySuccess(`Substitution complete. ${subName} is now in the lineup.`);
        setInjuredPlayerId('');
        setInjuredPlayerSearch('');
        setSubPlayerId('');
        setSubPlayerSearch('');
      }
    } finally {
      setSavingInjurySub(false);
    }
  }

  async function handleStartDraft() {
    if (!draftSession) return;
    setStartingDraft(true);
    setStartDraftError(null);
    try {
      const res = await fetch('/api/draft/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft_session_id: draftSession.id }),
      });
      if (res.ok) {
        router.push(`/draft/${draftSession.id}`);
      } else {
        const err = await res.json();
        setStartDraftError(err.message ?? err.error ?? 'Could not start draft. Make sure the scheduled time has passed.');
      }
    } finally { setStartingDraft(false); }
  }

  async function handleSaveSettings(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!league) return;
    setSavingSettings(true);
    setSettingsError(null);
    setSettingsSuccess(false);
    const form = new FormData(e.currentTarget);
    const patch = {
      injury_sub_enabled: form.get('injury_sub_enabled') === 'true',
      activation_timing: form.get('activation_timing') as string,
      scoring_includes_play_in: form.get('scoring_includes_play_in') === 'true',
      bench_lock_mode: form.get('bench_lock_mode') as string,
    };
    try {
      const res = await fetch('/api/commissioner/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ league_id: leagueId, settings: patch }),
      });
      if (!res.ok) {
        const err = await res.json();
        setSettingsError(err.error ?? 'Failed to save settings.');
      } else {
        const data = await res.json();
        setLeague(data.league as League);
        setSettingsSuccess(true);
        setTimeout(() => setSettingsSuccess(false), 3000);
      }
    } finally { setSavingSettings(false); }
  }

  async function handleVoidPick(e: React.FormEvent) {
    e.preventDefault();
    if (!replacementId || !voidReason.trim() || !voidPickNumber) { setVoidError('Fill in all fields.'); return; }
    const pickNum = parseInt(voidPickNumber, 10);
    if (isNaN(pickNum) || pickNum < 1) { setVoidError('Enter a valid pick number.'); return; }
    setVoidingPick(true);
    setVoidError(null);
    setVoidSuccess(null);
    try {
      // Fetch picks to find the pick_id from the pick number
      const { data: picks } = await supabase.from('draft_picks')
        .select('id, player_id')
        .eq('draft_session_id', draftSession!.id)
        .eq('pick_number', pickNum)
        .is('voided_at', null)
        .maybeSingle();
      if (!picks) { setVoidError(`Pick #${pickNum} not found or already voided.`); setVoidingPick(false); return; }
      const res = await fetch('/api/commissioner/pick/void', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pick_id: picks.id, void_reason: voidReason, replacement_player_id: replacementId }),
      });
      if (!res.ok) {
        const err = await res.json();
        setVoidError(err.error ?? 'Failed to void pick.');
      } else {
        const repName = players.find((p) => p.id === replacementId)?.name ?? replacementId;
        setVoidSuccess(`Pick #${pickNum} voided. ${repName} inserted as replacement.`);
        setVoidPickNumber('');
        setVoidReason('');
        setReplacementId('');
        setReplacementSearch('');
      }
    } finally { setVoidingPick(false); }
  }

  const playerMap = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);

  const pendingInvites = useMemo(() => invites.filter((i) => i.status === 'pending'), [invites]);
  const expiredInvites = useMemo(() => invites.filter((i) => i.status === 'expired'), [invites]);

  const loadCorrectPicks = useCallback(async () => {
    if (!draftSession) return;
    try {
      const res = await fetch(`/api/draft/state/${draftSession.id}`);
      if (!res.ok) return;
      const data = await res.json();
      const picks = (data.picks as DraftPick[])
        .filter((p) => !p.voided_at)
        .sort((a, b) => a.round_number - b.round_number || a.pick_number - b.pick_number);
      setCorrectPicks(picks);
      setCorrectDisplayNames(data.display_names ?? {});
    } finally {
      setCorrectPicksLoading(false);
    }
  }, [draftSession]);

  useEffect(() => {
    if (draftSession?.status === 'complete') {
      loadCorrectPicks();
    }
  }, [draftSession?.status, loadCorrectPicks]);

  function resetCorrectFlow() {
    setCorrectStep(1);
    setSelectedPick(null);
    setCorrectAvailable([]);
    setCorrectSearch('');
    setCorrectReplacementId('');
    setCorrectVoidReason('');
    setCorrectError(null);
  }

  async function handleSelectPick(pick: DraftPick) {
    setSelectedPick(pick);
    setCorrectStep(2);
    setCorrectError(null);
    setCorrectReplacementId('');
    setCorrectSearch('');

    const position = playerMap.get(pick.player_id)?.position;
    setCorrectAvailableLoading(true);
    try {
      const url = position
        ? `/api/league/${leagueId}/available-players?position=${position}`
        : `/api/league/${leagueId}/available-players`;
      const res = await fetch(url);
      if (res.ok) {
        const data: GetPlayersResponse = await res.json();
        setCorrectAvailable(data.players);
      } else {
        setCorrectAvailable([]);
      }
    } finally {
      setCorrectAvailableLoading(false);
    }
  }

  async function handleConfirmCorrection() {
    if (!selectedPick || !correctReplacementId || !correctVoidReason.trim()) {
      setCorrectError('A void reason is required.');
      return;
    }
    setCorrectSubmitting(true);
    setCorrectError(null);
    try {
      const res = await fetch('/api/commissioner/pick/void', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pick_id: selectedPick.id,
          void_reason: correctVoidReason.trim(),
          replacement_player_id: correctReplacementId,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        setCorrectError(err.message ?? err.error ?? 'Failed to correct pick.');
      } else {
        setCorrectSuccess('Pick corrected.');
        setTimeout(() => setCorrectSuccess(null), 4000);
        resetCorrectFlow();
        setCorrectPicksLoading(true);
        await loadCorrectPicks();
      }
    } finally {
      setCorrectSubmitting(false);
    }
  }

  const loadInvites = useCallback(async () => {
    if (!leagueId) return;
    const res = await fetch(`/api/league/${leagueId}/invites`);
    if (!res.ok) return;
    const data: GetInvitesResponse = await res.json();
    setInvites(data.invites);
  }, [leagueId]);

  useEffect(() => {
    if (currentMember?.role !== 'commissioner') return;
    (async () => {
      await loadInvites();
    })();
  }, [currentMember, loadInvites]);

  async function handleSendInvite(e: React.FormEvent) {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email) return;

    setInviteSending(true);
    setInviteError(null);
    setInviteSuccess(null);
    try {
      const res = await fetch('/api/league/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ league_id: leagueId, email }),
      });
      if (!res.ok) {
        const err = await res.json();
        setInviteError(err.error ?? 'Failed to send invite.');
      } else {
        setInviteSuccess(`Invite sent to ${email}.`);
        setInviteEmail('');
        await loadInvites();
      }
    } catch {
      setInviteError('Failed to send invite.');
    } finally {
      setInviteSending(false);
    }
  }

  async function handleResendInvite(invite: InviteListItem) {
    const oldToken = invite.token;
    setResendingToken(oldToken);
    setInviteError(null);
    try {
      const res = await fetch('/api/league/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ league_id: leagueId, email: invite.invited_email }),
      });
      if (!res.ok) {
        setInviteError('Failed to resend invite.');
        return;
      }

      const patchRes = await fetch(`/api/league/invite/${oldToken}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'expired' }),
      });
      if (!patchRes.ok) {
        console.error('Failed to expire old invite token:', oldToken);
      }

      await loadInvites();
    } finally {
      setResendingToken(null);
    }
  }

  async function handleCancelInvite(token: string) {
    setCancelingToken(token);
    try {
      await fetch(`/api/league/invite/${token}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'expired' }),
      });
      await loadInvites();
    } finally {
      setCancelingToken(null);
    }
  }

  async function handleChangeRole(member: LeagueMember, role: 'member' | 'co_commissioner') {
    setRoleChangingUserId(member.user_id);
    setMemberActionError(null);
    try {
      const res = await fetch(`/api/league/${leagueId}/members/${member.user_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const err = await res.json();
        setMemberActionError(err.message ?? err.error ?? 'Failed to update member role.');
      } else {
        const data: UpdateMemberRoleResponse = await res.json();
        setMembers((prev) => prev.map((m) => (m.user_id === member.user_id ? data.member : m)));
      }
    } catch {
      setMemberActionError('Failed to update member role.');
    } finally {
      setRoleChangingUserId(null);
    }
  }

  async function handleConfirmRemove() {
    if (!removeTarget) return;
    setRemovingUserId(removeTarget.user_id);
    setMemberActionError(null);
    try {
      const res = await fetch(`/api/league/${leagueId}/members/${removeTarget.user_id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const err = await res.json();
        setMemberActionError(err.message ?? err.error ?? 'Failed to remove member.');
      } else {
        setMembers((prev) => prev.filter((m) => m.user_id !== removeTarget.user_id));
        setRemoveTarget(null);
      }
    } catch {
      setMemberActionError('Failed to remove member.');
    } finally {
      setRemovingUserId(null);
    }
  }

  // Resolve a participant's bench (pre-draft this is usually empty)
  const loadBench = useCallback(
    async (userId: string): Promise<Player[]> => {
      const { data: slots } = await supabase
        .from('roster_slots')
        .select('player_id')
        .eq('league_id', leagueId)
        .eq('user_id', userId)
        .eq('is_bench', true)
        .is('released_at_round_stage', null);

      if (!slots || slots.length === 0) return [];
      const ids = new Set(slots.map((s) => s.player_id));
      return players.filter((p) => ids.has(p.id));
    },
    [leagueId, players]
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-black">
        <AppHeader leagueId={leagueId} />
        <div className="flex items-center justify-center py-24">
          <p className="text-neutral-500">Loading commissioner tools…</p>
        </div>
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="min-h-screen bg-black">
        <AppHeader leagueId={leagueId} />
        <div className="flex items-center justify-center px-4 py-24">
          <p className="text-center text-neutral-300">
            You don&apos;t have commissioner access to this league.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black">
      <AppHeader leagueId={leagueId} />
      <div className="px-4 py-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-1 text-2xl font-bold text-white sm:text-3xl">Commissioner Tools</h1>
        <p className="mb-6 text-neutral-500">{league?.name} · Season {league?.season}</p>

        {/* Demo league banner */}
        {league?.is_demo && !demoBannerDismissed && (
          <div className="mb-6 flex items-start justify-between gap-3 rounded-lg border border-yellow-400/30 bg-yellow-400/10 p-4">
            <p className="text-sm text-yellow-300">
              This is a demo league. You have full commissioner access. Your progress is saved for 24 hours.
            </p>
            <button
              onClick={() => setDemoBannerDismissed(true)}
              className="shrink-0 text-xs font-medium text-yellow-400 hover:text-yellow-200"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Setup guide for brand-new leagues */}
        {!draftSession && (
          <div className="mb-6 rounded-lg border border-yellow-400/30 bg-yellow-400/10 p-4">
            <p className="text-sm font-semibold text-yellow-300">Getting started</p>
            <ol className="mt-2 space-y-1 text-sm text-yellow-100 list-decimal list-inside">
              <li>Set the draft order below (random shuffle or manual).</li>
              <li>Schedule a date and pick timer using the Draft Scheduler.</li>
              <li>Share the draft room link with your participants.</li>
            </ol>
          </div>
        )}

        {draftSession && (
          <div className="mb-6 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-neutral-500">Draft status</p>
                <p className="font-semibold text-white capitalize">{draftSession.status}</p>
              </div>
              <div className="flex items-center gap-2">
                {draftSession.status === 'scheduled' && (
                  <button
                    onClick={handleStartDraft}
                    disabled={startingDraft}
                    className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700 disabled:opacity-50"
                  >
                    {startingDraft ? 'Starting…' : 'Start Draft'}
                  </button>
                )}
                {(draftSession.status === 'scheduled' || draftSession.status === 'live') && (
                  <a href={`/draft/${draftSession.id}`} className="rounded-md bg-yellow-400 px-3 py-1.5 text-xs font-semibold text-black hover:bg-yellow-300">
                    Open Room →
                  </a>
                )}
                {draftSession.status === 'complete' && (
                  <a href={`/league/${leagueId}/leaderboard`} className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700">
                    View Standings →
                  </a>
                )}
              </div>
            </div>
            {startDraftError && <p className="mt-2 text-sm text-red-400">{startDraftError}</p>}
          </div>
        )}

        <div className="flex flex-col gap-6">
          <DraftOrderGenerator
            members={members}
            memberLabels={memberLabels}
            initialOrder={draftSession?.snake_order}
            onSave={handleSaveOrder}
            saving={savingOrder}
          />

          <DraftScheduler
            initialScheduledStart={draftSession?.scheduled_start}
            initialPickTimerSeconds={draftSession?.pick_timer_seconds}
            onSave={handleSaveSchedule}
            saving={savingSchedule}
            showScheduledStart={!league?.is_demo}
          />

          <PlayerPositionOverride
            leagueId={leagueId}
            players={players}
            onSaved={(updated) =>
              setPlayers((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
            }
          />

          <BenchOrderOverride
            leagueId={leagueId}
            members={members}
            memberLabels={memberLabels}
            loadBench={loadBench}
          />

          {/* League Members & Invites */}
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold text-neutral-200">League Members &amp; Invites</h2>

            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Members</h3>
            <ul className="mb-2 divide-y divide-neutral-800">
              {members.map((m) => (
                <li key={m.user_id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-white">
                      {memberLabels[m.user_id] ?? m.user_id}
                    </p>
                    <p className="text-xs text-neutral-500">
                      Joined {format(new Date(m.joined_at), 'MMMM d, yyyy')}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300">
                      {ROLE_LABELS[m.role]}
                    </span>
                    {currentMember?.role === 'commissioner' && m.role !== 'commissioner' && (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            handleChangeRole(m, m.role === 'co_commissioner' ? 'member' : 'co_commissioner')
                          }
                          disabled={roleChangingUserId === m.user_id}
                          className="rounded-md border border-neutral-700 px-2 py-1 text-xs font-medium text-neutral-300 hover:border-yellow-400/40 hover:text-yellow-400 disabled:opacity-50"
                        >
                          {roleChangingUserId === m.user_id
                            ? 'Saving…'
                            : m.role === 'co_commissioner'
                              ? 'Demote to member'
                              : 'Promote to co-commissioner'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setRemoveTarget(m)}
                          className="rounded-md border border-neutral-700 px-2 py-1 text-xs font-medium text-neutral-300 hover:border-red-400/40 hover:text-red-400"
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {memberActionError && <p className="mb-4 text-sm text-red-400">{memberActionError}</p>}

            {currentMember?.role === 'commissioner' && (
              <>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Pending Invites</h3>
                {pendingInvites.length === 0 ? (
                  <p className="mb-4 text-sm text-neutral-500">No pending invites.</p>
                ) : (
                  <ul className="mb-4 divide-y divide-neutral-800">
                    {pendingInvites.map((invite) => (
                      <li key={invite.id} className="flex items-center justify-between gap-3 py-2.5">
                        <div className="min-w-0">
                          <p className="truncate text-sm text-white">{invite.invited_email}</p>
                          <p className="text-xs text-neutral-500">
                            Sent {format(new Date(invite.sent_at), 'MMMM d, yyyy')}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="rounded bg-yellow-400/10 px-2 py-0.5 text-xs text-yellow-400">Pending</span>
                          <button
                            type="button"
                            onClick={() => handleResendInvite(invite)}
                            disabled={resendingToken === invite.token}
                            className="rounded-md border border-neutral-700 px-2 py-1 text-xs font-medium text-neutral-300 hover:border-yellow-400/40 hover:text-yellow-400 disabled:opacity-50"
                          >
                            {resendingToken === invite.token ? 'Resending…' : 'Resend'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleCancelInvite(invite.token)}
                            disabled={cancelingToken === invite.token}
                            className="rounded-md border border-neutral-700 px-2 py-1 text-xs font-medium text-neutral-300 hover:border-red-400/40 hover:text-red-400 disabled:opacity-50"
                          >
                            {cancelingToken === invite.token ? 'Canceling…' : 'Cancel'}
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                {expiredInvites.length > 0 && (
                  <div className="mb-4">
                    <button
                      type="button"
                      onClick={() => setShowExpiredInvites((v) => !v)}
                      className="text-sm text-yellow-400 hover:underline"
                    >
                      {showExpiredInvites ? 'Hide' : 'Show'} expired ({expiredInvites.length})
                    </button>
                    {showExpiredInvites && (
                      <ul className="mt-2 divide-y divide-neutral-800">
                        {expiredInvites.map((invite) => (
                          <li key={invite.id} className="flex items-center justify-between gap-3 py-2.5">
                            <div className="min-w-0">
                              <p className="truncate text-sm text-neutral-400">{invite.invited_email}</p>
                              <p className="text-xs text-neutral-500">
                                Sent {format(new Date(invite.sent_at), 'MMMM d, yyyy')}
                              </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">Expired</span>
                              <button
                                type="button"
                                onClick={() => handleResendInvite(invite)}
                                disabled={resendingToken === invite.token}
                                className="rounded-md border border-neutral-700 px-2 py-1 text-xs font-medium text-neutral-300 hover:border-yellow-400/40 hover:text-yellow-400 disabled:opacity-50"
                              >
                                {resendingToken === invite.token ? 'Resending…' : 'Resend'}
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Invite Member</h3>
                <form onSubmit={handleSendInvite} className="flex gap-2">
                  <input
                    type="email"
                    required
                    placeholder="email@example.com"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-400"
                  />
                  <button
                    type="submit"
                    disabled={inviteSending}
                    className="shrink-0 rounded-md bg-yellow-400 px-4 py-2 text-sm font-medium text-black hover:bg-yellow-300 disabled:opacity-50"
                  >
                    {inviteSending ? 'Sending…' : 'Send Invite'}
                  </button>
                </form>
                {inviteSuccess && <p className="mt-2 text-sm text-green-400">{inviteSuccess}</p>}
                {inviteError && <p className="mt-2 text-sm text-red-400">{inviteError}</p>}
              </>
            )}
          </div>

          {/* Injury Substitution */}
          {league?.settings.injury_sub_enabled && (
            <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-sm">
              <h2 className="mb-4 text-lg font-semibold text-neutral-200">Injury Substitution</h2>
              <form onSubmit={handleInjurySub} className="flex flex-col gap-3">
                {/* Injured player */}
                <div>
                  <label className="mb-1 block text-sm font-medium text-neutral-300">Injured Player</label>
                  <input
                    type="text"
                    placeholder="Search by name…"
                    value={injuredPlayerSearch}
                    onChange={(e) => { setInjuredPlayerSearch(e.target.value); setInjuredPlayerId(''); setInjurySuccess(null); }}
                    className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-400"
                  />
                  {injuredPlayerSearch.trim().length >= 2 && !injuredPlayerId && (
                    <ul className="mt-1 max-h-40 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-900 shadow-sm">
                      {players.filter((p) => p.name.toLowerCase().includes(injuredPlayerSearch.toLowerCase())).slice(0, 6).map((p) => (
                        <li key={p.id} className="cursor-pointer px-3 py-2 text-sm hover:bg-neutral-800"
                          onClick={() => { setInjuredPlayerId(p.id); setInjuredPlayerSearch(p.name); }}>
                          {p.name} <span className="text-neutral-500">({p.position})</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {injuredPlayerId && <p className="mt-1 text-xs text-green-400">Selected: {injuredPlayerSearch}</p>}
                </div>

                {/* Optional explicit sub */}
                <div>
                  <label className="mb-1 block text-sm font-medium text-neutral-300">Sub Player <span className="font-normal text-neutral-500">(leave blank to auto-select from bench)</span></label>
                  <input
                    type="text"
                    placeholder="Search by name…"
                    value={subPlayerSearch}
                    onChange={(e) => { setSubPlayerSearch(e.target.value); setSubPlayerId(''); }}
                    className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-400"
                  />
                  {subPlayerSearch.trim().length >= 2 && !subPlayerId && (
                    <ul className="mt-1 max-h-40 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-900 shadow-sm">
                      {players.filter((p) => p.name.toLowerCase().includes(subPlayerSearch.toLowerCase())).slice(0, 6).map((p) => (
                        <li key={p.id} className="cursor-pointer px-3 py-2 text-sm hover:bg-neutral-800"
                          onClick={() => { setSubPlayerId(p.id); setSubPlayerSearch(p.name); }}>
                          {p.name} <span className="text-neutral-500">({p.position})</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {subPlayerId && <p className="mt-1 text-xs text-green-400">Selected: {subPlayerSearch}</p>}
                </div>

                {injuryError && <p className="text-sm text-red-400">{injuryError}</p>}
                {injurySuccess && <p className="text-sm text-green-400">{injurySuccess}</p>}

                <button
                  type="submit"
                  disabled={savingInjurySub || !injuredPlayerId}
                  className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  {savingInjurySub ? 'Processing…' : 'Apply Injury Sub'}
                </button>
              </form>
            </div>
          )}

          {/* Manual Score Entry */}
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold text-neutral-200">Enter Score Manually</h2>
            <form onSubmit={handleManualScore} className="flex flex-col gap-3">
              {/* Player search */}
              <div>
                <label className="mb-1 block text-sm font-medium text-neutral-300">Player</label>
                <input
                  type="text"
                  placeholder="Search by name…"
                  value={scorePlayerSearch}
                  onChange={(e) => {
                    setScorePlayerSearch(e.target.value);
                    setScorePlayerId('');
                    setScoreSuccess(false);
                  }}
                  className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-400"
                />
                {scorePlayerSearch.trim().length >= 2 && !scorePlayerId && (
                  <ul className="mt-1 max-h-48 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-900 shadow-sm">
                    {players
                      .filter((p) =>
                        p.name.toLowerCase().includes(scorePlayerSearch.toLowerCase())
                      )
                      .slice(0, 8)
                      .map((p) => (
                        <li
                          key={p.id}
                          className="cursor-pointer px-3 py-2 text-sm hover:bg-neutral-800"
                          onClick={() => {
                            setScorePlayerId(p.id);
                            setScorePlayerSearch(p.name);
                          }}
                        >
                          {p.name} <span className="text-neutral-500">({p.position})</span>
                        </li>
                      ))}
                    {players.filter((p) => p.name.toLowerCase().includes(scorePlayerSearch.toLowerCase())).length === 0 && (
                      <li className="px-3 py-2 text-sm text-neutral-500">No players found</li>
                    )}
                  </ul>
                )}
                {scorePlayerId && (
                  <p className="mt-1 text-xs text-green-400">Selected: {scorePlayerSearch}</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-neutral-300">Round</label>
                  <select
                    value={scoreRoundStage}
                    onChange={(e) => setScoreRoundStage(e.target.value as typeof ROUND_STAGES[number])}
                    className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-400"
                  >
                    {ROUND_STAGES.map((s) => (
                      <option key={s} value={s}>{ROUND_STAGE_LABELS[s]}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-neutral-300">Round #</label>
                  <input
                    type="number"
                    min={1}
                    value={scoreRoundNumber}
                    onChange={(e) => setScoreRoundNumber(parseInt(e.target.value, 10) || 1)}
                    className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-400"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-neutral-300">Game Date</label>
                  <input
                    type="date"
                    required
                    value={scoreGameDate}
                    onChange={(e) => setScoreGameDate(e.target.value)}
                    className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-400"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-neutral-300">Points</label>
                  <input
                    type="number"
                    min={0}
                    required
                    placeholder="0"
                    value={scorePoints}
                    onChange={(e) => setScorePoints(e.target.value)}
                    className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-400"
                  />
                </div>
              </div>

              {scoreError && <p className="text-sm text-red-400">{scoreError}</p>}
              {scoreSuccess && (
                <p className="text-sm text-green-400">Score saved and leaderboard is updating.</p>
              )}

              <button
                type="submit"
                disabled={savingScore || !scorePlayerId}
                className="rounded-md bg-yellow-400 px-4 py-2 text-sm font-medium text-black hover:bg-yellow-300 disabled:opacity-50"
              >
                {savingScore ? 'Saving…' : 'Save Score'}
              </button>
            </form>
          </div>

          {/* League Settings */}
          {league && (
            <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-sm">
              <h2 className="mb-4 text-lg font-semibold text-neutral-200">League Settings</h2>
              <form onSubmit={handleSaveSettings} className="flex flex-col gap-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-sm font-medium text-neutral-300">Injury Subs</label>
                    <select name="injury_sub_enabled" defaultValue={String(league.settings.injury_sub_enabled ?? false)}
                      className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-400">
                      <option value="false">Disabled</option>
                      <option value="true">Enabled</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-neutral-300">Activation Timing</label>
                    <select name="activation_timing" defaultValue={league.settings.activation_timing ?? 'immediate'}
                      className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-400">
                      <option value="immediate">Immediate (bench activates same day)</option>
                      <option value="end_of_round">End of Round</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-neutral-300">Play-In Scoring</label>
                    <select name="scoring_includes_play_in" defaultValue={String(league.settings.scoring_includes_play_in ?? true)}
                      className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-400">
                      <option value="true">Include Play-In games</option>
                      <option value="false">Exclude Play-In games</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-neutral-300">Bench Lock Mode</label>
                    <select name="bench_lock_mode" defaultValue={league.settings.bench_lock_mode ?? 'before_first_game'}
                      className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-400">
                      <option value="before_first_game">Lock before first game</option>
                      <option value="always_editable">Always editable</option>
                    </select>
                  </div>
                </div>
                {settingsError && <p className="text-sm text-red-400">{settingsError}</p>}
                {settingsSuccess && <p className="text-sm text-green-400">Settings saved.</p>}
                <button type="submit" disabled={savingSettings}
                  className="self-start rounded-md bg-yellow-400 px-4 py-2 text-sm font-medium text-black hover:bg-yellow-300 disabled:opacity-50">
                  {savingSettings ? 'Saving…' : 'Save Settings'}
                </button>
              </form>
            </div>
          )}

          {/* Void & Replace Pick */}
          {draftSession && (draftSession.status === 'live' || draftSession.status === 'complete') && (
            <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-sm">
              <h2 className="mb-1 text-lg font-semibold text-neutral-200">Void & Replace Pick</h2>
              <p className="mb-4 text-xs text-neutral-500">A replacement player is required — void without replacement is not supported.</p>
              <form onSubmit={handleVoidPick} className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-sm font-medium text-neutral-300">Pick #</label>
                    <input type="number" min={1} placeholder="e.g. 5" value={voidPickNumber}
                      onChange={(e) => setVoidPickNumber(e.target.value)}
                      className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-400" />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-neutral-300">Void Reason</label>
                    <input type="text" placeholder="Wrong pick, admin error…" value={voidReason}
                      onChange={(e) => setVoidReason(e.target.value)}
                      className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-400" />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-neutral-300">Replacement Player</label>
                  <input type="text" placeholder="Search by name…" value={replacementSearch}
                    onChange={(e) => { setReplacementSearch(e.target.value); setReplacementId(''); setVoidSuccess(null); }}
                    className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-400" />
                  {replacementSearch.trim().length >= 2 && !replacementId && (
                    <ul className="mt-1 max-h-40 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-900 shadow-sm">
                      {players.filter((p) => p.name.toLowerCase().includes(replacementSearch.toLowerCase())).slice(0, 6).map((p) => (
                        <li key={p.id} className="cursor-pointer px-3 py-2 text-sm hover:bg-neutral-800"
                          onClick={() => { setReplacementId(p.id); setReplacementSearch(p.name); }}>
                          {p.name} <span className="text-neutral-500">({p.position})</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {replacementId && <p className="mt-1 text-xs text-green-400">Selected: {replacementSearch}</p>}
                </div>
                {voidError && <p className="text-sm text-red-400">{voidError}</p>}
                {voidSuccess && <p className="text-sm text-green-400">{voidSuccess}</p>}
                <button type="submit" disabled={voidingPick || !replacementId || !voidReason.trim() || !voidPickNumber}
                  className="self-start rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
                  {voidingPick ? 'Voiding…' : 'Void & Replace'}
                </button>
              </form>
            </div>
          )}

          {/* Correct a Pick (3-step) */}
          {draftSession && draftSession.status === 'complete' && (
            <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-sm">
              <h2 className="mb-1 text-lg font-semibold text-neutral-200">Correct a Pick</h2>
              <p className="mb-4 text-xs text-neutral-500">Step {correctStep} of 3</p>

              {correctSuccess && <p className="mb-3 text-sm text-green-400">{correctSuccess}</p>}

              {correctStep === 1 && (
                <div>
                  {correctPicksLoading ? (
                    <p className="text-sm text-neutral-500">Loading picks…</p>
                  ) : correctPicks.length === 0 ? (
                    <p className="text-sm text-neutral-500">No picks found.</p>
                  ) : (
                    <ul className="max-h-80 divide-y divide-neutral-800 overflow-y-auto rounded-md border border-neutral-800">
                      {correctPicks.map((pick) => {
                        const player = playerMap.get(pick.player_id);
                        return (
                          <li
                            key={pick.id}
                            onClick={() => handleSelectPick(pick)}
                            className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-neutral-800"
                          >
                            <span className="w-10 shrink-0 text-neutral-400">#{pick.pick_number}</span>
                            <span className="flex-1 text-white">{correctDisplayNames[pick.user_id] ?? pick.user_id}</span>
                            <span className="flex-1 text-neutral-300">
                              {player?.name ?? pick.player_id}
                              {player && (
                                <span className="text-neutral-500">
                                  {' '}({player.position}{player.teams ? ` · ${player.teams.name}` : ''})
                                </span>
                              )}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}

              {correctStep === 2 && selectedPick && (
                <div>
                  <p className="mb-2 text-sm text-neutral-300">
                    Selecting replacement for pick #{selectedPick.pick_number} —{' '}
                    {playerMap.get(selectedPick.player_id)?.name ?? selectedPick.player_id}
                  </p>
                  <input
                    type="text"
                    placeholder="Search by name…"
                    value={correctSearch}
                    onChange={(e) => setCorrectSearch(e.target.value)}
                    className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-400"
                  />
                  {correctAvailableLoading ? (
                    <p className="mt-2 text-sm text-neutral-500">Loading available players…</p>
                  ) : (
                    <ul className="mt-2 max-h-60 divide-y divide-neutral-800 overflow-y-auto rounded-md border border-neutral-800">
                      {correctAvailable
                        .filter((p) => p.name.toLowerCase().includes(correctSearch.toLowerCase()))
                        .slice(0, 50)
                        .map((p) => (
                          <li
                            key={p.id}
                            onClick={() => { setCorrectReplacementId(p.id); setCorrectStep(3); }}
                            className="cursor-pointer px-3 py-2 text-sm hover:bg-neutral-800"
                          >
                            {p.name}{' '}
                            <span className="text-neutral-500">
                              ({p.position}{p.teams ? ` · ${p.teams.name}` : ''})
                            </span>
                          </li>
                        ))}
                      {correctAvailable.length === 0 && (
                        <li className="px-3 py-2 text-sm text-neutral-500">No available players found.</li>
                      )}
                    </ul>
                  )}
                  <button onClick={resetCorrectFlow} className="mt-3 text-sm text-neutral-400 hover:text-yellow-400">
                    ← Back to picks
                  </button>
                </div>
              )}

              {correctStep === 3 && selectedPick && (() => {
                const oldPlayer = playerMap.get(selectedPick.player_id);
                const newPlayer = correctAvailable.find((p) => p.id === correctReplacementId);
                return (
                  <div>
                    <p className="mb-3 text-sm text-neutral-300">
                      Replace{' '}
                      <span className="font-semibold text-white">{oldPlayer?.name ?? selectedPick.player_id}</span>
                      {oldPlayer?.teams ? ` (${oldPlayer.teams.name})` : ''} with{' '}
                      <span className="font-semibold text-white">{newPlayer?.name ?? correctReplacementId}</span>
                      {newPlayer?.teams ? ` (${newPlayer.teams.name})` : ''}?
                    </p>
                    <label className="mb-1 block text-sm font-medium text-neutral-300">Void Reason</label>
                    <input
                      type="text"
                      placeholder="Wrong pick, admin error…"
                      value={correctVoidReason}
                      onChange={(e) => setCorrectVoidReason(e.target.value)}
                      className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-400"
                    />
                    {correctError && <p className="mt-2 text-sm text-red-400">{correctError}</p>}
                    <div className="mt-3 flex gap-3">
                      <button onClick={() => setCorrectStep(2)} className="text-sm text-neutral-400 hover:text-yellow-400">
                        ← Back
                      </button>
                      <button
                        onClick={handleConfirmCorrection}
                        disabled={correctSubmitting || !correctVoidReason.trim()}
                        className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                      >
                        {correctSubmitting ? 'Saving…' : 'Confirm Correction'}
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      </div>
      </div>

      {removeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-lg">
            <p className="text-sm text-white">
              Remove {memberLabels[removeTarget.user_id] ?? removeTarget.user_id} from the league?
            </p>
            <p className="mt-2 text-sm text-neutral-400">
              They will lose access immediately. Their draft picks and scores will remain in the league history.
            </p>
            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setRemoveTarget(null)}
                className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm font-medium text-neutral-300 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmRemove}
                disabled={removingUserId === removeTarget.user_id}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {removingUserId === removeTarget.user_id ? 'Removing…' : 'Remove Member'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
