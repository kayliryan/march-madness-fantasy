'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import { DraftOrderGenerator } from '@/components/DraftOrderGenerator';
import { DraftScheduler } from '@/components/DraftScheduler';
import { PlayerPositionOverride } from '@/components/PlayerPositionOverride';
import { BenchOrderOverride } from '@/components/BenchOrderOverride';
import type {
  DraftSession,
  GetLeagueResponse,
  GetPlayersResponse,
  League,
  LeagueMember,
  Player,
} from '@/lib/types';

export default function CommissionerPage() {
  const params = useParams<{ league_id: string }>();
  const leagueId = params.league_id;
  const router = useRouter();

  const [league, setLeague] = useState<League | null>(null);
  const [members, setMembers] = useState<LeagueMember[]>([]);
  const [memberLabels, setMemberLabels] = useState<Record<string, string>>({});
  const [players, setPlayers] = useState<Player[]>([]);
  const [draftSession, setDraftSession] = useState<DraftSession | null>(null);

  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);

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
      await fetch('/api/draft/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          league_id: leagueId,
          season: league.season,
          snake_order: orderedUserIds,
        }),
      });
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
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-gray-500">Loading commissioner tools…</p>
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <p className="text-center text-gray-600">
          You don&apos;t have commissioner access to this league.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-1 text-3xl font-bold text-gray-900">Commissioner Tools</h1>
        <p className="mb-8 text-gray-600">{league?.name}</p>

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
        </div>
      </div>
    </div>
  );
}
