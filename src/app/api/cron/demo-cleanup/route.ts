import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';

const JOB_NAME = 'demo_cleanup';

// Best-effort lock release — 10-minute timeout (Section 3.18) is the fallback if this fails.
async function releaseCronLock(jobName: string): Promise<void> {
  try {
    await supabaseAdmin.from('cron_locks').delete().eq('job_name', jobName);
  } catch { /* best effort */ }
}

// Daily cleanup of orphaned "Try as Commissioner" demo leagues (Section 14.8):
// leagues whose anonymous commissioner session has been auto-deleted by Supabase's
// 24-hour anonymous user expiry (or abandoned), and which aren't mid-draft.
export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET) {
    console.error('[demo-cleanup] CRON_SECRET not configured');
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const instanceId = crypto.randomUUID();

  // Acquire cron lock (Section 3.18). No row returned = another instance holds a fresh lock.
  const { data: lockRows } = await supabaseAdmin.rpc('acquire_cron_lock', {
    p_job_name: JOB_NAME,
    p_instance_id: instanceId,
  });

  if (!lockRows || lockRows.length === 0) {
    return NextResponse.json({ in_progress: true });
  }

  const { data: orphanedData, error: fetchError } = await supabaseAdmin
    .rpc('get_orphaned_demo_league_data');

  if (fetchError) {
    console.error('demo-cleanup: failed to fetch orphaned data', fetchError);
    await releaseCronLock(JOB_NAME);
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }

  if (!orphanedData || orphanedData.length === 0) {
    await releaseCronLock(JOB_NAME);
    return NextResponse.json({ deleted: 0 });
  }

  // Delete AI member auth.users rows BEFORE deleting leagues
  // (league_members cascade destroys the mapping after league deletion).
  const aiMemberIds = [...new Set(
    (orphanedData as { ai_member_user_id: string }[]).map((r) => r.ai_member_user_id)
  )];
  for (const id of aiMemberIds) {
    await supabaseAdmin.auth.admin.deleteUser(id).catch(() => {});
  }

  // Delete orphaned leagues
  const leagueIds = [...new Set(
    (orphanedData as { league_id: string }[]).map((r) => r.league_id)
  )];

  // Fetch commissioner_ids before the leagues row is gone.
  // For TTL-expired leagues (condition B in get_orphaned_demo_league_data), the
  // commissioner's auth.users row still exists and must be deleted. For orphaned
  // leagues (condition A, commissioner already gone), deleteUser is a no-op.
  const { data: leagueRows } = await supabaseAdmin
    .from('leagues')
    .select('commissioner_id')
    .in('id', leagueIds);
  const commissionerIds = [...new Set(
    (leagueRows ?? []).map((r) => r.commissioner_id as string)
  )];
  for (const id of commissionerIds) {
    await supabaseAdmin.auth.admin.deleteUser(id).catch(() => {});
  }

  const { error: deleteError } = await supabaseAdmin
    .rpc('delete_orphaned_demo_leagues', { p_league_ids: leagueIds });

  if (deleteError) {
    console.error('demo-cleanup: failed to delete orphaned leagues', { leagueIds, error: deleteError });
    // AI member auth rows already deleted. Leagues remain but have no AI members.
    // Known edge case: these leagues are permanently un-cleanable by future runs
    // (get_orphaned_demo_league_data joins on is_ai_member = true which no longer exists).
    // Future improvement: add a second cleanup pass for is_demo leagues with no AI members.
    await releaseCronLock(JOB_NAME);
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  // Mirrors what an auth.users -> public.users ON DELETE CASCADE would do if that
  // FK existed: drop the now-orphaned public.users rows for AI members and the commissioner.
  const orphanedUserIds = [...new Set([...aiMemberIds, ...commissionerIds])];
  const { error: usersDeleteError } = await supabaseAdmin
    .rpc('delete_orphaned_demo_users', { p_user_ids: orphanedUserIds });
  if (usersDeleteError) {
    console.error('demo-cleanup: failed to delete orphaned public.users rows', { orphanedUserIds, error: usersDeleteError });
    // Non-fatal — leagues are already cleaned up. get_orphaned_demo_league_data joins
    // through league_members (already deleted), so these rows won't be retried by
    // future runs — they're harmless leftover rows, not a re-entrancy hazard.
  }

  await releaseCronLock(JOB_NAME);
  return NextResponse.json({ deleted: leagueIds.length });
}
