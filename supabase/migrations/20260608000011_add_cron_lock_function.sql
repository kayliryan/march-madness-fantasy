-- Atomic cron lock acquisition (Section 3.18).
-- Returns 1 row if the lock was acquired; 0 rows if another instance holds a fresh lock.
-- Called as: supabaseAdmin.rpc('acquire_cron_lock', { p_job_name, p_instance_id })
CREATE OR REPLACE FUNCTION acquire_cron_lock(p_job_name TEXT, p_instance_id TEXT)
RETURNS SETOF cron_locks AS $$
  INSERT INTO cron_locks (job_name, locked_at, locked_by, timeout_minutes)
  VALUES (p_job_name, now(), p_instance_id, 10)
  ON CONFLICT (job_name) DO UPDATE
    SET locked_at = now(), locked_by = p_instance_id
    WHERE cron_locks.locked_at < now() - (cron_locks.timeout_minutes || ' minutes')::interval
  RETURNING *;
$$ LANGUAGE SQL SECURITY DEFINER;
