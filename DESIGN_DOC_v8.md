MARCH MADNESS FANTASY
Full-Stack Web Application
Technical Design Document  |  v8.0 — Final



| Author | Kayli |
| --- | --- |
| Version | 8.0 — Final |
| Status | Approved — Hand to Claude Code |
| Tech Stack | Next.js 14 · TypeScript · Supabase (PostgreSQL) · Tailwind CSS · shadcn/ui · Vercel |
| Auth | Supabase Auth + Google OAuth 2.0 + Email/Password |
| AI | Anthropic Claude API (draft advisor, standings narrator) |
| Email | Resend |
| SMS | Twilio (optional, v1) |
| Stats API | ESPN Unofficial (v1) → SportsRadar (upgrade path) |
| v8 Changelog | end_of_round round completion clarified as tournament-wide not per-league; bench_lock_deadline computation specified (first game tip-off from ESPN schedule, commissioner-overridable, NULL for always_editable); ScoreAccumulator.runForPlayer() no-op for end_of_round documented; DELETE /api/draft/queue route fixed to /:session_id/:player_id; Section 13 (Key Tradeoffs) added covering all major design decisions from eight audit rounds |




# 1. Product Overview

March Madness Fantasy replaces a manual family spreadsheet with a real-time fantasy sports platform built around the NCAA Men's Basketball Tournament. Snake-draft league creation, live scoring, AI-assisted draft decisions, and year-over-year historical standings.

Phase 1 — Single private family league
Phase 2 — Multi-tenant: any group runs their own league
Phase 3 — 1M+ DAU with documented infrastructure migration path (Section 11)

All data models designed so Phase 2 requires zero structural schema changes. Phase 3 migrations documented so no architectural decisions need revisiting under load.


# 2. Game Rules & Scoring Logic


## 2.1 Round Stage Ordering

Round stages stored as plain text strings. All comparisons use index position in ROUND_STAGE_ORDER. Lexicographic comparison is incorrect and must never be used.

ROUND_STAGE_ORDER constant — defined once in src/lib/constants/rounds.ts, imported everywhere:
['draft', 'play_in', 'r64', 'r32', 's16', 'e8', 'f4', 'championship']

'draft' is a sentinel at index 0 — earlier than all tournament rounds. All draft-time roster_slots use this as acquired_at_round_stage.
Stage comparison: stageA < stageB → ROUND_STAGE_ORDER.indexOf(stageA) < ROUND_STAGE_ORDER.indexOf(stageB)
Next stage lookup: ROUND_STAGE_ORDER[ROUND_STAGE_ORDER.indexOf(currentStage) + 1]. Used by end_of_round activation.
Adding a new stage: insert at correct position in constants/rounds.ts. Update Zod schema. No database migration required.
'draft_cancelled' is a second sentinel for released_at_round_stage on roster_slots voided by draft cancellation. NOT in ROUND_STAGE_ORDER. Audit only.


## 2.2 Roster Composition


| Slot | Position | Default Count | Notes |
| --- | --- | --- | --- |
| Starter | Guard (G) | 2 | Must fill before any bench picks |
| Starter | Forward (F) | 2 | Must fill before any bench picks |
| Starter | Center (C) | 1 | Must fill before any bench picks |
| Bench | Any position mix | 3 | Filled only after all starter slots complete |



## 2.3 Substitution Rules


| Open Slot | Eligible Bench Player | Notes |
| --- | --- | --- |
| Guard (G) | Bench G or Bench F | G and F interchangeable |
| Forward (F) | Bench G or Bench F | G and F interchangeable |
| Center (C) | Bench C only | C fully isolated |


slot_position is the source of truth for all sub eligibility. slot_key is a display label only, inherited by incoming player unchanged.
Example: slot_key='G1', slot_position='G' vacated. Incoming bench F gets slot_key='G1', slot_position='F'. Future subs use open_slot_position='F'.
BenchOrderService receives open_slot_position from slot_position of the vacated slot, never from slot_key.
Eliminated bench player skipped; system tries next eligible player.
If no eligible bench player exists, slot stays empty — valid game state.


## 2.4 Substitution Trigger Timing

Controlled by activation_timing in league settings (default: 'immediate').


### immediate (default)

RosterActivationService triggers as soon as team elimination detected by sync job.
acquired_at_round_stage for activated bench player = current round_stage at activation time.
Bench player can score in games later the same day on a different team still playing.


### end_of_round

RosterActivationService does NOT trigger on individual team eliminations.
Round completion is detected globally (tournament-wide), not per league. The sync job checks: are all game_scores rows for the current round_stage and season final? This is a global check because game_scores is a player-level table shared across all leagues.
When round completion is detected: the sync job calls RosterActivationService in a single batch for all leagues that have activation_timing = 'end_of_round' AND have pending eliminations (teams marked is_eliminated = true without a corresponding active bench player).
acquired_at_round_stage = ROUND_STAGE_ORDER[indexOf(completedStage) + 1] — the next round stage. Bench player inactive for completed round, active from next round.
Championship edge case: if completedStage = 'championship', acquired_at_round_stage = 'championship'. Player is active but no games remain.
ScoreAccumulator.runForPlayer() is called inline after end_of_round activation per code path consistency, but produces no scoring_events — no games have been played in the next round yet. This is correct behavior, not a bug.


## 2.5 Injury Substitutions

Controlled by injury_sub_enabled toggle (default: false)
When enabled: commissioner can swap injured active player before team elimination
Once subbed out via injury, player cannot return (default). Commissioner override logged with override_reason.
When toggle is off: injured players score 0 but remain in slot


## 2.6 Bench Order & Lock

Single ranked list per participant (Sub 1, Sub 2, Sub 3). Available from pre-draft explorer.
Default if never submitted: ranked by avg PPG descending.
Bench orders are private (owner + commissioner only) until bench_lock_deadline passes. After lock, all league members can view each other's bench orders.
bench_lock_deadline is set on draft_sessions at session creation. Value = scheduled tip-off time of the first game of the season (play_in or r64), fetched from the ESPN schedule feed during initial season setup sync. Commissioner can override this value manually. For always_editable mode, bench_lock_deadline = NULL (field not used).
locked_at is set by the sync job: on each execution, the sync job checks whether bench_lock_deadline < now() for each active league. If so: UPDATE bench_orders SET locked_at = bench_lock_deadline WHERE league_id = ? AND locked_at IS NULL. Idempotent.


## 2.7 ScoreAccumulator Algorithm

Unit of computation: per game_score_id. All stage comparisons use ROUND_STAGE_ORDER.indexOf() — never lexicographic.

For each game_scores row where game_status = 'final':
Find all roster_slots rows where player_id matches AND league_id is in scope.
gameIdx = ROUND_STAGE_ORDER.indexOf(game.round_stage). acqIdx = ROUND_STAGE_ORDER.indexOf(slot.acquired_at_round_stage). If slot.released_at_round_stage is NULL or not in ROUND_STAGE_ORDER: relIdx = Infinity. Else: relIdx = ROUND_STAGE_ORDER.indexOf(slot.released_at_round_stage). Check: acqIdx <= gameIdx AND gameIdx < relIdx.
If passes: upsert scoring_events with points_credited = game_scores.points, roster_slot_id = matching slot.
If no match: no scoring_events row.
On correction: re-run for affected game_score_ids. Delete and re-insert. Clear is_stale in same transaction.

'draft' (index 0): players drafted before tournament pass check for all tournament rounds including play-in.
'draft_cancelled' not in ROUND_STAGE_ORDER: indexOf returns -1. relIdx check treats it as Infinity. These slots never score.


## 2.8 SCORING_AFFECTING_SETTINGS

Defined in src/lib/constants/settings.ts:
SCORING_AFFECTING_SETTINGS = ['sub_eligibility_matrix', 'scoring_includes_play_in', 'activation_timing']

tiebreaker_strategies: NOT included. Evaluated at query time from existing scoring_events. A settings change takes effect on the next leaderboard query with no re-computation.
PATCH /api/commissioner/settings: if any key in patch intersects SCORING_AFFECTING_SETTINGS, call ScoreAccumulator.runForLeague(league_id) after the write.


## 2.9 is_stale Write Path

Sync job upserts game_scores AND sets is_stale = true on matching scoring_events rows — same transaction
roster_slots updates set is_stale = true on affected scoring_events rows — same transaction
ScoreAccumulator clears is_stale = false as final step — same transaction
Leaderboard shows 'Scores updating...' when any is_stale = true for the league


## 2.10 ScoreAccumulator Trigger Paths

Sync job: ScoreAccumulator.runForGames(game_score_ids[]) after each batch of game_scores upserts.
Settings change: ScoreAccumulator.runForLeague(league_id) if changed key in SCORING_AFFECTING_SETTINGS.
Substitution: ScoreAccumulator.runForPlayer(player_id, league_id) inline after bench player activation. For end_of_round activations this is a no-op (next round not yet played) but is called for code path consistency.


## 2.11 Tiebreaker

Default: participant whose single active player scored most points in any one game wins. Evaluated at query time. Configurable ranked strategy list in league settings. Changes take effect immediately on next leaderboard query.


## 2.12 Draft Types

Default: snake. Stored in league settings. Switching to linear or auction is a settings change.


# 3. Data Models

All tables include created_at and updated_at unless noted. RLS enforced at database layer on every league-scoped table — see Section 6. Schema managed via hand-written SQL files in supabase/migrations/, applied via supabase db push.


## 3.1 users


| Column | Type | Notes |
| --- | --- | --- |
| id | uuid (PK) | FK to Supabase auth.users.id |
| external_auth_id | text UNIQUE | IAM migration hook. NULL until migration. |
| display_name | text NOT NULL | User-editable |
| avatar_url | text |  |
| bio | text |  |
| notification_preferences | jsonb NOT NULL DEFAULT '{}' |  |
| created_at | timestamptz NOT NULL |  |



## 3.2 leagues


| Column | Type | Notes |
| --- | --- | --- |
| id | uuid (PK) |  |
| name | text NOT NULL |  |
| season | integer NOT NULL |  |
| commissioner_id | uuid (FK → users) |  |
| settings | jsonb NOT NULL | All configurable rules — Section 4.3 |
| invite_token | text UNIQUE |  |
| is_demo | boolean NOT NULL DEFAULT false |  |
| stats_sync_status | enum NOT NULL DEFAULT 'ok' | ok | degraded | manual |
| created_at | timestamptz NOT NULL |  |



## 3.3 league_members


| Column | Type | Notes |
| --- | --- | --- |
| id | uuid (PK) |  |
| league_id | uuid (FK → leagues) |  |
| user_id | uuid (FK → users) |  |
| role | enum NOT NULL | member | co_commissioner | commissioner |
| draft_order_position | integer | Snapshot computed at draft start. Changing post-start has no effect. |
| joined_at | timestamptz NOT NULL |  |
| invited_by | uuid (FK → users) |  |



## 3.4 league_invites


| Column | Type | Notes |
| --- | --- | --- |
| id | uuid (PK) |  |
| league_id | uuid (FK → leagues) |  |
| invited_email | text NOT NULL |  |
| invited_by | uuid (FK → users) |  |
| token | text UNIQUE NOT NULL |  |
| status | enum NOT NULL | pending | accepted | expired |
| sent_at | timestamptz NOT NULL |  |
| accepted_at | timestamptz |  |
| expires_at | timestamptz NOT NULL |  |



## 3.5 teams


| Column | Type | Notes |
| --- | --- | --- |
| id | uuid (PK) |  |
| season | integer NOT NULL |  |
| name | text NOT NULL |  |
| seed | integer NOT NULL |  |
| region | text NOT NULL |  |
| is_eliminated | boolean NOT NULL DEFAULT false |  |
| eliminated_in_round_stage | text | NULL until eliminated |
| eliminated_in_round_number | integer |  |
| espn_team_id | text | Provider-agnostic field name |
| synced_at | timestamptz |  |



## 3.6 players


| Column | Type | Notes |
| --- | --- | --- |
| id | uuid (PK) |  |
| season | integer NOT NULL |  |
| name | text NOT NULL |  |
| team_id | uuid (FK → teams) |  |
| position | enum NOT NULL | G | F | C |
| position_overridden | boolean NOT NULL DEFAULT false |  |
| position_override_note | text | Required when overridden |
| avg_ppg | numeric NOT NULL DEFAULT 0 |  |
| injury_status | enum | active | day_to_day | out | NULL |
| injury_note | text | NULL if no report |
| injury_updated_at | timestamptz |  |
| espn_player_id | text |  |
| synced_at | timestamptz |  |


Player availability derived per-league from roster_slots. Not stored on players table.


## 3.7 draft_sessions


| Column | Type | Notes |
| --- | --- | --- |
| id | uuid (PK) |  |
| league_id | uuid (FK → leagues) |  |
| season | integer NOT NULL |  |
| status | enum NOT NULL | scheduled | live | complete | cancelled — see state machine Section 5.1 |
| draft_type | enum NOT NULL DEFAULT 'snake' | snake | linear | auction |
| scheduled_start | timestamptz NOT NULL | Target time. Draft goes live only when commissioner clicks 'Start Draft' and scheduled_start <= now() is validated. |
| started_at | timestamptz |  |
| completed_at | timestamptz |  |
| snake_order | uuid[] NOT NULL DEFAULT '{}' | Immutable snapshot frozen at live transition |
| current_pick_number | integer NOT NULL DEFAULT 1 | Optimistic lock target |
| pick_timer_seconds | integer | NULL = unlimited |
| bench_lock_deadline | timestamptz | Tip-off time of first tournament game, fetched from ESPN schedule during season setup. NULL for always_editable mode. Commissioner-overridable. |



## 3.8 draft_picks

Append-only. Corrections use void-and-replace. replacement_player_id always required when voiding — void-without-replacement not supported in v1.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid (PK) |  |
| draft_session_id | uuid (FK → draft_sessions) |  |
| league_id | uuid (FK → leagues) |  |
| pick_number | integer NOT NULL | UNIQUE with draft_session_id |
| round_number | integer NOT NULL |  |
| user_id | uuid (FK → users) |  |
| player_id | uuid (FK → players) |  |
| picked_at | timestamptz NOT NULL |  |
| time_taken_seconds | integer |  |
| was_auto_picked | boolean NOT NULL DEFAULT false |  |
| voided_at | timestamptz |  |
| voided_by | uuid (FK → users) |  |
| void_reason | text | Required when voided |
| replaces_pick_id | uuid (FK → draft_picks) | Self-referential: correction points to voided pick |



## 3.9 roster_slots

Append-only. acquired_at_round_stage = 'draft' for all players drafted before tournament. released_at_round_stage = 'draft_cancelled' for slots voided by draft cancellation. slot_key is display label; slot_position is source of truth for eligibility and morphs on substitution.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid (PK) |  |
| league_id | uuid (FK → leagues) |  |
| user_id | uuid (FK → users) |  |
| player_id | uuid (FK → players) |  |
| slot_key | text NOT NULL | Display label (e.g. 'G1'). Inherited by sub. NOT used for eligibility. |
| slot_position | enum NOT NULL | G | F | C. Source of truth for sub eligibility. Morphs to incoming player's position on substitution. |
| is_active | boolean NOT NULL |  |
| is_bench | boolean NOT NULL |  |
| acquired_at_round_stage | text NOT NULL | 'draft' for draft-time. Current stage for immediate subs. Next stage for end_of_round subs. |
| released_at_round_stage | text | NULL if active. 'draft_cancelled' if draft was cancelled. |
| release_reason | enum | eliminated | injury_sub | correction | traded | waiver | draft_cancelled | NULL |
| override_by | uuid (FK → users) |  |
| override_reason | text | Required when override_by set |



## 3.10 Round Stage Convention


| Stage Value | In ROUND_STAGE_ORDER | Index | Description |
| --- | --- | --- | --- |
| draft | Yes | 0 | Sentinel: pre-tournament |
| play_in | Yes | 1 | Play-in games |
| r64 | Yes | 2 | Round of 64 |
| r32 | Yes | 3 | Round of 32 |
| s16 | Yes | 4 | Sweet 16 |
| e8 | Yes | 5 | Elite 8 |
| f4 | Yes | 6 | Final Four |
| championship | Yes | 7 | National Championship |
| draft_cancelled | NO | N/A | Sentinel: cancellation audit only |



## 3.11 game_scores


| Column | Type | Notes |
| --- | --- | --- |
| id | uuid (PK) |  |
| player_id | uuid (FK → players) |  |
| season | integer NOT NULL |  |
| round_stage | text NOT NULL |  |
| round_number | integer NOT NULL DEFAULT 1 |  |
| game_date | date NOT NULL |  |
| game_status | enum NOT NULL | scheduled | in_progress | final |
| points | integer NOT NULL DEFAULT 0 |  |
| source | enum NOT NULL | manual | espn_api | sportsradar_api |
| synced_at | timestamptz NOT NULL |  |


UNIQUE constraint on (player_id, round_stage, round_number, game_date) required for UPSERT ON CONFLICT. Non-unique index silently inserts duplicates. See index table Section 3.19.


## 3.12 scoring_events

Regular table. Written exclusively by ScoreAccumulator. Single source of truth for leaderboard queries.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid (PK) |  |
| league_id | uuid (FK → leagues) |  |
| user_id | uuid (FK → users) |  |
| player_id | uuid (FK → players) |  |
| game_score_id | uuid (FK → game_scores) | UNIQUE with league_id + user_id |
| round_stage | text NOT NULL |  |
| points_credited | integer NOT NULL |  |
| roster_slot_id | uuid (FK → roster_slots) | Active slot at game time |
| is_stale | boolean NOT NULL DEFAULT false | Set atomically with invalidating writes. Cleared atomically by ScoreAccumulator. |



## 3.13 leaderboard_snapshots

Pre-computed totals written by ScoreAccumulator at end of each complete round. O(1) lookup at scale. round_stage set at full round completion only — partial re-runs do not update it.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid (PK) |  |
| league_id | uuid (FK → leagues) |  |
| user_id | uuid (FK → users) |  |
| total_points | integer NOT NULL DEFAULT 0 |  |
| active_player_count | integer NOT NULL DEFAULT 0 |  |
| highest_single_game_points | integer NOT NULL DEFAULT 0 | Tiebreaker |
| last_computed_at | timestamptz NOT NULL |  |
| round_stage | text NOT NULL | Most recently completed full round. Set explicitly by ScoreAccumulator. Not updated on partial re-runs. |


Per-round breakdown: SELECT round_stage, SUM(points_credited) FROM scoring_events WHERE league_id=? AND user_id=? GROUP BY round_stage. Separate from snapshot by design.


## 3.14 bench_orders


| Column | Type | Notes |
| --- | --- | --- |
| id | uuid (PK) |  |
| league_id | uuid (FK → leagues) |  |
| user_id | uuid (FK → users) |  |
| ordered_player_ids | uuid[] NOT NULL DEFAULT '{}' | Resolved at sub-time by BenchOrderService. Never mutated by corrections. |
| submitted_at | timestamptz | NULL triggers PPG-default fallback |
| locked_at | timestamptz | Set by sync job when bench_lock_deadline < now(). NULL until deadline. |
| last_edited_by | uuid (FK → users) |  |
| last_edited_at | timestamptz |  |



## 3.15 draft_queues


| Column | Type | Notes |
| --- | --- | --- |
| id | uuid (PK) |  |
| league_id | uuid (FK → leagues) |  |
| draft_session_id | uuid (FK → draft_sessions) |  |
| user_id | uuid (FK → users) |  |
| player_id | uuid (FK → players) |  |
| queue_position | integer NOT NULL |  |
| added_at | timestamptz NOT NULL |  |
| removed_at | timestamptz | Soft delete |



## 3.16 timer_extensions


| Column | Type | Notes |
| --- | --- | --- |
| id | uuid (PK) |  |
| draft_session_id | uuid (FK → draft_sessions) |  |
| pick_number | integer NOT NULL |  |
| extended_by | uuid (FK → users) |  |
| extension_seconds | integer | NULL = unlimited/pause |
| reason | text |  |
| created_at | timestamptz NOT NULL |  |



## 3.17 league_notifications

Written exclusively by NotificationService using service role key. INSERT RLS = FALSE as safeguard against direct client writes.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid (PK) |  |
| league_id | uuid (FK → leagues) |  |
| type | enum NOT NULL | round_end_digest | draft_reminder | custom_blast | draft_turn_alert |
| channel | enum NOT NULL | email | sms |
| subject | text | NULL for SMS |
| body | text NOT NULL |  |
| ai_generated | boolean NOT NULL DEFAULT false |  |
| sent_at | timestamptz |  |
| created_by | uuid (FK → users) | NULL for system-generated. Set for commissioner-initiated. |
| created_at | timestamptz NOT NULL |  |



## 3.18 cron_locks

Prevents concurrent cron execution. Acquire is atomic: INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING *. No row returned = exit silently, no retry, no error.

| Column | Type | Notes |
| --- | --- | --- |
| job_name | text (PK) | e.g. 'score_sync', 'injury_sync' |
| locked_at | timestamptz NOT NULL |  |
| locked_by | text NOT NULL | Vercel invocation ID or hostname |
| timeout_minutes | integer NOT NULL DEFAULT 10 | Stale lock threshold |


Exact acquire SQL (use verbatim):
INSERT INTO cron_locks (job_name, locked_at, locked_by, timeout_minutes)
VALUES ($job_name, now(), $instance_id, 10)
ON CONFLICT (job_name) DO UPDATE
SET locked_at = now(), locked_by = $instance_id
WHERE cron_locks.locked_at < now() - (cron_locks.timeout_minutes || ' minutes')::interval
RETURNING *;

Row returned: lock acquired. Proceed.
No row returned: fresh lock held by another instance. Exit silently — not an error, not a retry.
On completion or handled failure: DELETE FROM cron_locks WHERE job_name = $job_name.


## 3.19 Index Strategy


| Table | Index | Type | Reason |
| --- | --- | --- | --- |
| draft_picks | (draft_session_id, pick_number) | UNIQUE | Primary concurrency guard |
| draft_picks | (draft_session_id, player_id) WHERE voided_at IS NULL | PARTIAL UNIQUE | Prevents duplicate active picks. Standard UNIQUE breaks commissioner correction. |
| roster_slots | (league_id, user_id, slot_key) WHERE is_active = true AND released_at_round_stage IS NULL | PARTIAL UNIQUE | Prevents duplicate active slots. Database-level double-activation guard. |
| roster_slots | (league_id, user_id, is_active) | Composite | Current roster query |
| roster_slots | (player_id, league_id) | Composite | Player availability check |
| roster_slots | (league_id, acquired_at_round_stage, released_at_round_stage) | Composite | Historical reconstruction |
| scoring_events | (game_score_id, league_id, user_id) | UNIQUE | Prevents duplicate credit |
| scoring_events | (league_id, user_id) | Composite | Per-user aggregation (v1 leaderboard) |
| scoring_events | (league_id, is_stale) | Composite | Stale-row detection |
| leaderboard_snapshots | (league_id, user_id) | UNIQUE | O(1) leaderboard lookup |
| game_scores | (player_id, round_stage, round_number, game_date) | UNIQUE | Required for UPSERT ON CONFLICT. Non-unique silently inserts duplicates. |
| game_scores | (player_id, round_stage, game_status) | Composite | Sync and accumulator lookups |
| players | (season, team_id) | Composite | Explorer filtering |
| players | (espn_player_id) | UNIQUE | API sync lookups |



# 4. System Architecture


## 4.1 Tech Stack


| Layer | Technology | Rationale |
| --- | --- | --- |
| Frontend | Next.js 14 (App Router) + TypeScript | SSR + client components, existing React background |
| Styling | Tailwind CSS + shadcn/ui | Production-grade components |
| Database | Supabase (PostgreSQL) | RLS, Realtime, jsonb. Fully portable standard Postgres. |
| Auth | Supabase Auth | Google OAuth + email/password. external_auth_id enables IAM migration. |
| Real-time | Supabase Realtime | Live draft. Upgrade: Ably via RealtimeProvider abstraction. |
| Background jobs | Vercel Cron Jobs | Adaptive sync. Upgrade: BullMQ on Redis. |
| Hosting | Vercel | One-click Next.js deploy |
| AI | Anthropic Claude API | Draft advisor + standings narrator |
| Email | Resend | Transactional + digest |
| SMS | Twilio (optional) | Draft turn alerts |
| Stats v1 | ESPN Unofficial API | Free. MOCK_ESPN=true for local. Fallback: manual entry. |
| Stats v2 | SportsRadar | Upgrade via StatsProvider adapter — no schema changes |



## 4.2 Service Layer

DraftEngine — pick submission with optimistic locking, snake order, timer, auto-pick, position enforcement (server-side 422). Section 5.3.
RosterActivationService — triggered by sync job (immediate: per elimination; end_of_round: per round completion). Slot release + activation in one transaction. Calls ScoreAccumulator.runForPlayer() inline. Alerts commissioner after 3 failed retries.
ScoreAccumulator — per-game_score_id algorithm (Section 2.7). Three trigger paths (Section 2.10). SCORING_AFFECTING_SETTINGS constant (Section 2.8). Writes scoring_events + leaderboard_snapshots. Manages is_stale atomically. Fully idempotent.
StatsProvider (interface) — ESPNStatsProvider and SportsRadarStatsProvider implement same contract. MOCK_ESPN=true returns fixture data server-side.
BenchOrderService — full algorithm Section 5.4. Receives open_slot_position from slot_position of vacated slot.
NotificationService — in-app, email (Resend), SMS (Twilio). Uses service role key. Writes league_notifications.
CommissionerService — order generation, pick voiding (always requires replacement_player_id), bench override, position override.


## 4.3 League Settings Schema


| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| draft_type | enum | 'snake' | snake | linear | auction |
| draft_order_lock_days_before | integer | 3 |  |
| pick_timer_seconds | integer | 90 | NULL = unlimited |
| starter_slots | object | { G:2, F:2, C:1 } | Drives enforcement and slot key generation |
| bench_slots | integer | 3 |  |
| sub_eligibility_matrix | object | { G:['G','F'], F:['G','F'], C:['C'] } | In SCORING_AFFECTING_SETTINGS |
| bench_lock_mode | enum | 'before_first_game' | before_first_game | always_editable |
| activation_timing | enum | 'immediate' | immediate | end_of_round. In SCORING_AFFECTING_SETTINGS. |
| injury_sub_enabled | boolean | false |  |
| injury_sub_reversible | boolean | false |  |
| tiebreaker_strategies | array | ['highest_single_active_game'] | NOT in SCORING_AFFECTING_SETTINGS |
| scoring_includes_play_in | boolean | true | In SCORING_AFFECTING_SETTINGS |
| stats_provider | enum | 'espn' | espn | sportsradar |
| notifications | object | { round_end_email:true, daily_digest:false, ai_summary:true } |  |
| email_tone | enum | 'playful' | NOT in SCORING_AFFECTING_SETTINGS |



## 4.4 Concurrency Model — Live Draft

All three races resolved at database layer. No shared memory across serverless instances.


### Race 1: Double-pick

UNIQUE constraint on (draft_session_id, pick_number). Second insert: 409 Conflict.


### Race 2: Manual pick vs. auto-pick timer

Submission includes expected_pick_number. Check current_pick_number === expected. Mismatch: 409. Match: INSERT + INCREMENT atomically.
Auto-pick re-fetches highest available avg PPG excluding all non-voided picks. Race condition: UNIQUE constraint catches it, auto-pick retries once. If retry fails (theoretically impossible with 300+ players): draft completes with slot unfilled.


### Race 3: Reconnect confusion

Full state snapshot on reconnect. 'Reconnecting...' overlay. Pick submission disabled until snapshot received.


## 4.5 Transaction Boundaries


| Operation | Tables Written Atomically | Why |
| --- | --- | --- |
| Submit draft pick | draft_picks (insert) + draft_sessions.current_pick_number (increment) | Pick with no order advance leaves draft stuck |
| Activate substitution | roster_slots (release old) + roster_slots (insert new active) | Ghost slot if activation fails after release |
| Process elimination | teams.is_eliminated + roster_slots (release) + roster_slots (activate bench) | Partial elimination corrupts roster permanently |
| Sync game scores | game_scores (upsert) + scoring_events.is_stale = true | is_stale must be in same transaction |
| Update roster_slots | roster_slots (write) + scoring_events.is_stale = true | Same atomicity requirement |
| Void and correct pick | draft_picks (void) + draft_picks (insert correction) + roster_slots (correction) | Void without correction leaves gap in record |
| ScoreAccumulator run | scoring_events (delete stale + insert fresh) + leaderboard_snapshots (upsert) + is_stale = false | Partial re-computation = mixed data |
| Cron lock acquire | cron_locks (atomic upsert via ON CONFLICT DO UPDATE WHERE) | See exact SQL Section 3.18 |
| Bench lock enforcement | bench_orders SET locked_at WHERE locked_at IS NULL | Idempotent batch UPDATE by sync job |



## 4.6 ESPN API Fallback Runbook

3 consecutive failures in 15 min → stats_sync_status = 'degraded'
UI banner: 'Live scores being entered manually by your commissioner.'
Commissioner alert: 'Score sync unavailable. Use manual score entry.'
Commissioner enters scores manually — source: 'manual'
ESPN recovers → status cleared. ESPN values take precedence unless commissioner flagged manual as authoritative.


## 4.7 Sync Job Full Execution Flow

Three responsibilities. All run on every execution. This is the authoritative reference.


### Responsibility 1: Score Sync

Acquire cron_locks (Section 3.18 SQL). No row returned: exit silently.
Check game_status. Any in_progress: 30-second polling mode.
Fetch game_scores from StatsProvider for current round_stage.
UPSERT game_scores ON CONFLICT (player_id, round_stage, round_number, game_date) DO UPDATE.
Same transaction: set is_stale = true on scoring_events matching upserted game_score_ids.
Call ScoreAccumulator.runForGames(upserted_game_score_ids).
Detect newly eliminated teams. Update teams.is_eliminated = true. For leagues with activation_timing = 'immediate': call RosterActivationService inline per elimination.


### Responsibility 2: Bench Lock Enforcement

For each active league: check bench_lock_deadline < now() AND any bench_orders rows have locked_at IS NULL.
If yes: UPDATE bench_orders SET locked_at = bench_lock_deadline WHERE league_id = ? AND locked_at IS NULL. Idempotent.


### Responsibility 3: Activation Timing (end_of_round only)

Check globally: are all game_scores rows for the current round_stage and season final? This is tournament-wide, not per-league — game_scores is a player-level table shared across all leagues.
If round is complete: call RosterActivationService in a single batch for all leagues with activation_timing = 'end_of_round' that have pending eliminations.
acquired_at_round_stage = ROUND_STAGE_ORDER[indexOf(completedStage) + 1]. Championship edge case: acquired_at_round_stage = 'championship'.

After all three responsibilities: release cron_locks (DELETE WHERE job_name = $job_name).

Leagues with activation_timing = 'immediate' have RosterActivationService called in Responsibility 1. end_of_round leagues are handled in Responsibility 3. Both call the same RosterActivationService — timing differs, service logic does not.


## 4.8 Sync Job Error Recovery

All game_scores upserts idempotent via UPSERT ON CONFLICT (requires UNIQUE index — Section 3.19)
Retry: 3 attempts, exponential backoff (1s, 4s, 16s). After 3 failures: degraded status, commissioner alerted.
Cron auth: Authorization: Bearer {CRON_SECRET}. API route verifies before executing. Invalid secret: 401.


## 4.9 Adaptive Stats Sync


| Data Type | Baseline | Active Game | Trigger |
| --- | --- | --- | --- |
| Game scores | Every 5 min | Every 30 sec | Any game_scores row has game_status = 'in_progress' |
| Injury reports | Every 15 min | Every 5 min | During tournament date range |
| Team eliminations | With score sync | With score sync | Derived from final game scores |
| Player/team metadata | Once daily | Once daily | Low change frequency |



## 4.10 AI Draft Advisor

Available players only in system prompt. ~$0.04–$0.08/query. ~$1–2 per 10-person draft.
Pre-draft questions cached on player_id. Live draft advice not cached — context changes every pick.


## 4.11 JWT Token Refresh in Draft Room

Supabase client auto-refreshes. Draft room adds 10-minute heartbeat: supabase.auth.getSession()
Refresh failure: non-blocking warning. 401 on pick submission: refresh + retry once. Second failure: prompt re-auth.


## 4.12 RosterActivationService Failure Handling

Transaction rolls back atomically on failure
Retry: 3 attempts, exponential backoff
After 3 failures: commissioner alerted with user_id, slot_key, slot_position


# 5. Algorithms & State Machines


## 5.1 draft_sessions Status State Machine

scheduled_start is a target time. Draft goes live only when commissioner clicks 'Start Draft' and server validates scheduled_start <= now(). bench_lock_deadline set at session creation to the tip-off time of the first tournament game, fetched from ESPN schedule during season setup.


| From | To | Trigger | Side Effects |
| --- | --- | --- | --- |
| (none) | scheduled | Commissioner creates session | draft_order_position set. bench_lock_deadline set from ESPN schedule (first game tip-off). |
| scheduled | live | Commissioner clicks 'Start Draft' (validates scheduled_start <= now()) | started_at set. snake_order frozen. Realtime channel opened. |
| scheduled | cancelled | Commissioner cancels before start | No roster_slots or draft_picks affected. |
| live | complete | current_pick_number exceeds max_picks | completed_at set. Realtime channel closed. |
| live | cancelled | Commissioner cancels mid-draft | All draft_picks voided. All roster_slots get released_at_round_stage = 'draft_cancelled', release_reason = 'draft_cancelled'. Realtime channel closed. |
| complete | (terminal) | N/A |  |
| cancelled | (terminal) | N/A |  |


POST /api/draft/start when status is already 'live' or 'complete': returns 409 Conflict { error: 'DRAFT_ALREADY_LIVE', message: 'Draft is already in progress or complete.' }. Idempotent for double-click and network retry.


## 5.2 Snake Order Algorithm

n = snake_order.length. round_number = ceil(current_pick_number / n). position_in_round = (current_pick_number - 1) mod n.
Odd round (forward): active_user_id = snake_order[position_in_round]
Even round (reverse): active_user_id = snake_order[n - 1 - position_in_round]


| Pick # | Round | Position | Active (n=3, [A,B,C]) |
| --- | --- | --- | --- |
| 1 | 1 (fwd) | 0 | A |
| 2 | 1 (fwd) | 1 | B |
| 3 | 1 (fwd) | 2 | C |
| 4 | 2 (rev) | 0 | C |
| 5 | 2 (rev) | 1 | B |
| 6 | 2 (rev) | 2 | A |
| 7 | 3 (fwd) | 0 | A |


Max picks: n × roster_size. Complete when current_pick_number > max_picks.


## 5.3 DraftEngine Position Enforcement Algorithm

Server-side. Client enforcement cosmetic only. Returns 422: { error: 'POSITION_ENFORCEMENT', message: string, unfilled_positions: string[] }.

current_roster from roster_slots WHERE user_id = submitter AND league_id = ? AND is_active = true AND is_bench = false AND released_at_round_stage IS NULL.
Load starter_slots from league settings.
For each position P: filled_count[P] = rows where slot_position = P. required_count[P] = starter_slots[P].
is_starters_complete = every P has filled_count[P] >= required_count[P].
Get submitted_player_position from players table.
If is_starters_complete = false: open_for_position = required_count[position] - filled_count[position]. If > 0: valid starter pick, assign to lowest-numbered unfilled slot matching position, proceed. If = 0: 422 with unfilled_positions list.
If is_starters_complete = true: valid bench pick, assign to lowest-numbered unfilled bench slot, proceed.
INSERT draft_picks + INSERT roster_slots + INCREMENT current_pick_number in one transaction.


## 5.4 BenchOrderService Resolution Algorithm

Inputs: league_id, user_id, open_slot_position (from slot_position of vacated slot, never slot_key), sub_eligibility_matrix.

Load bench_orders. If submitted_at IS NULL or empty: fall back to bench players sorted by avg_ppg DESC.
eligible_positions = sub_eligibility_matrix[open_slot_position].
Iterate ordered_player_ids. Skip if: not in current valid roster_slots; is_bench = false; released_at_round_stage IS NOT NULL; position not in eligible_positions; team is_eliminated = true. First passing: proceed.
If none pass: slot remains empty. No error.
Activation (one transaction): release old row (release_reason = 'eliminated' or 'injury_sub'). Insert new: is_active = true, acquired_at_round_stage = current (immediate) or next (end_of_round), slot_key = inherited, slot_position = incoming player's position.


# 6. Row Level Security Policy Enumeration

RLS enforced at database layer. Application checks secondary. ScoreAccumulator, sync jobs, seed scripts use service role key (bypasses RLS). Service role key never exposed to client.


## 6.1 Security Note: Self-Join via Invite Token

league_members INSERT policy permits inserts where user_id = auth.uid(). Intentionally permissive at RLS layer. Application layer (POST /api/invite/:token/accept) must validate: token matches, status = 'pending', expires_at > now(). RLS alone does not prevent unauthorized joins. Application validation is required and must not be skipped.


## 6.2 Policy Table


| Table | Operation | Policy Predicate | Notes |
| --- | --- | --- | --- |
| leagues | SELECT | id IN (SELECT league_id FROM league_members WHERE user_id = auth.uid()) OR is_demo = true |  |
| leagues | INSERT | auth.uid() IS NOT NULL |  |
| leagues | UPDATE | commissioner_id = auth.uid() OR id IN (SELECT league_id FROM league_members WHERE user_id = auth.uid() AND role IN ('commissioner','co_commissioner')) |  |
| leagues | DELETE | commissioner_id = auth.uid() |  |
| league_members | SELECT | league_id IN (SELECT league_id FROM league_members lm2 WHERE lm2.user_id = auth.uid()) |  |
| league_members | INSERT | user_id = auth.uid() | Permissive. Application validates invite token. See 6.1. |
| league_members | UPDATE | league_id IN (SELECT id FROM leagues WHERE commissioner_id = auth.uid()) |  |
| league_members | DELETE | league_id IN (SELECT id FROM leagues WHERE commissioner_id = auth.uid()) | Members cannot self-remove in v1. |
| league_invites | SELECT | league_id IN (SELECT league_id FROM league_members WHERE user_id = auth.uid()) OR invited_email = (auth.jwt() ->> 'email') | JWT claim — no auth.users subquery. NULL email (anonymous) = correctly sees no invites. |
| league_invites | INSERT, UPDATE | league_id IN (SELECT id FROM leagues WHERE commissioner_id = auth.uid()) | Commissioner only |
| draft_sessions | SELECT | league_id IN (SELECT league_id FROM league_members WHERE user_id = auth.uid()) OR league_id IN (SELECT id FROM leagues WHERE is_demo = true) |  |
| draft_sessions | INSERT, UPDATE | league_id IN (SELECT id FROM leagues WHERE commissioner_id = auth.uid() OR id IN (SELECT league_id FROM league_members WHERE user_id = auth.uid() AND role IN ('commissioner','co_commissioner'))) |  |
| draft_picks | SELECT | league_id IN (SELECT league_id FROM league_members WHERE user_id = auth.uid()) OR league_id IN (SELECT id FROM leagues WHERE is_demo = true) |  |
| draft_picks | INSERT | league_id IN (SELECT league_id FROM league_members WHERE user_id = auth.uid()) AND NOT (auth.jwt() ->> 'role' = 'demo_viewer') |  |
| roster_slots | SELECT | league_id IN (SELECT league_id FROM league_members WHERE user_id = auth.uid()) OR league_id IN (SELECT id FROM leagues WHERE is_demo = true) |  |
| roster_slots | INSERT | league_id IN (SELECT league_id FROM league_members WHERE user_id = auth.uid()) AND NOT (auth.jwt() ->> 'role' = 'demo_viewer') |  |
| scoring_events | SELECT | league_id IN (SELECT league_id FROM league_members WHERE user_id = auth.uid()) OR league_id IN (SELECT id FROM leagues WHERE is_demo = true) |  |
| scoring_events | INSERT, UPDATE, DELETE | FALSE | Service role only |
| leaderboard_snapshots | SELECT | league_id IN (SELECT league_id FROM league_members WHERE user_id = auth.uid()) OR league_id IN (SELECT id FROM leagues WHERE is_demo = true) |  |
| leaderboard_snapshots | INSERT, UPDATE | FALSE | Service role only |
| draft_queues | SELECT | user_id = auth.uid() | Private. Supabase Realtime RLS-filtered broadcast must be explicitly configured — channel naming alone does not enforce this. |
| draft_queues | INSERT, UPDATE, DELETE | user_id = auth.uid() AND NOT (auth.jwt() ->> 'role' = 'demo_viewer') |  |
| bench_orders | SELECT | (user_id = auth.uid() OR league_id IN (SELECT id FROM leagues WHERE commissioner_id = auth.uid())) OR (league_id IN (SELECT league_id FROM league_members WHERE user_id = auth.uid()) AND locked_at IS NOT NULL) | Private pre-lock. Public to league members after locked_at set. |
| bench_orders | INSERT, UPDATE | (user_id = auth.uid() OR league_id IN (SELECT id FROM leagues WHERE commissioner_id = auth.uid())) AND NOT (auth.jwt() ->> 'role' = 'demo_viewer') |  |
| players | SELECT | TRUE | Public read |
| players | INSERT, UPDATE | FALSE | Service role only |
| teams | SELECT | TRUE | Public read |
| teams | INSERT, UPDATE | FALSE | Service role only |
| timer_extensions | SELECT | draft_session_id IN (SELECT id FROM draft_sessions WHERE league_id IN (SELECT league_id FROM league_members WHERE user_id = auth.uid())) |  |
| timer_extensions | INSERT | draft_session_id IN (SELECT id FROM draft_sessions WHERE league_id IN (SELECT id FROM leagues WHERE commissioner_id = auth.uid() OR id IN (SELECT league_id FROM league_members WHERE user_id = auth.uid() AND role IN ('commissioner','co_commissioner')))) | Commissioner and co-commissioner only |
| league_notifications | SELECT | league_id IN (SELECT league_id FROM league_members WHERE user_id = auth.uid()) |  |
| league_notifications | INSERT | FALSE | Service role only. NotificationService uses service role key. |
| cron_locks | SELECT, INSERT, UPDATE, DELETE | FALSE | Service role only |



# 7. API Contract

All routes under /api/. JSON responses. Auth via Supabase JWT in Authorization: Bearer header.


## 7.1 Standard Error Responses


| HTTP Status | Meaning | When Used |
| --- | --- | --- |
| 400 | Bad Request | Malformed body, Zod validation failure |
| 401 | Unauthorized | Missing or expired JWT. Client refreshes and retries once. |
| 403 | Forbidden | Authenticated but not authorized |
| 404 | Not Found | Resource not found or RLS prevents visibility |
| 409 | Conflict | Optimistic lock failure, double-pick, or invalid state transition |
| 422 | Unprocessable Entity | Business logic rejection. Body: { error: string, message: string, [context] } |
| 500 | Internal Server Error | Logged server-side. Generic error to client. |



## 7.2 Auth & Demo Endpoints


| Method | Route | Request Body | Response | Notes |
| --- | --- | --- | --- | --- |
| POST | /api/demo/session | (none) | { access_token, expires_at } | Creates anonymous Supabase session with demo_viewer JWT claim. |
| GET | /api/invite/:token | (none) | { league: { id, name, season }, invited_email, status, expires_at } | 404 if not found or expired. |
| POST | /api/invite/:token/accept | { display_name? } | { user: User, league_member: LeagueMember } | Validates token. 422 if accepted or expired. |
| POST | /api/invite | { league_id, email } | { invite: LeagueInvite } | Commissioner sends invite. 403 if not commissioner. |



## 7.3 Draft Endpoints


| Method | Route | Request Body | Response | Notes |
| --- | --- | --- | --- | --- |
| POST | /api/draft/start | { draft_session_id } | { session: DraftSession } | Commissioner only. Validates scheduled_start <= now(). Freezes snake_order. 409 if already live or complete: { error: 'DRAFT_ALREADY_LIVE' } |
| POST | /api/draft/pick | { draft_session_id, player_id, expected_pick_number } | { pick: DraftPick, next_pick_number: int, active_user_id: uuid } | 409 on lock fail. 422 on position enforcement: { error: 'POSITION_ENFORCEMENT', message, unfilled_positions: string[] } |
| GET | /api/draft/state/:session_id | (none) | { session, picks, available_players, current_turn: { user_id, pick_number, round_number, time_remaining_seconds } } | Full snapshot for reconnect. |
| POST | /api/draft/queue | { draft_session_id, player_id, queue_position } | { queue: DraftQueue[] } | 422 if player already drafted. |
| DELETE | /api/draft/queue/:session_id/:player_id | (none) | { queue: DraftQueue[] } | Soft delete. session_id in path prevents ambiguity for players queued across multiple sessions. |
| POST | /api/draft/timer/extend | { draft_session_id, pick_number, extension_seconds } | { timer_extension: TimerExtension } | Commissioner/co-commissioner only. extension_seconds: null = pause. |



## 7.4 Roster & Scoring Endpoints


| Method | Route | Request Body | Response | Notes |
| --- | --- | --- | --- | --- |
| GET | /api/league/:league_id/roster/:user_id | (none) | { active_starters, active_bench, released_starters, released_bench: RosterSlot[] } | Each slot includes player details and per-round points. |
| GET | /api/league/:league_id/leaderboard | (none) | { standings: [{ user_id, display_name, total_points, active_player_count, per_round }] } | total_points from leaderboard_snapshots. per_round from scoring_events GROUP BY round_stage. |
| POST | /api/league/:league_id/scores/manual | { player_id, round_stage, round_number, game_date, points } | { game_score: GameScore } | Commissioner only. source: 'manual'. Triggers ScoreAccumulator.runForGames(). |



## 7.5 Commissioner Endpoints


| Method | Route | Request Body | Response | Notes |
| --- | --- | --- | --- | --- |
| PATCH | /api/commissioner/pick/void | { pick_id, void_reason, replacement_player_id } | { voided_pick, correction_pick: DraftPick } | replacement_player_id required. Void-without-replacement not supported in v1. |
| PATCH | /api/commissioner/bench-order | { league_id, user_id, ordered_player_ids } | { bench_order: BenchOrder } | Works after lock deadline. |
| PATCH | /api/commissioner/player/position | { player_id, position, override_note } | { player: Player } | override_note required. |
| PATCH | /api/commissioner/settings | { league_id, settings } | { league: League } | Partial update. Zod validates. Calls ScoreAccumulator.runForLeague() if key in SCORING_AFFECTING_SETTINGS changed. |
| POST | /api/commissioner/draft/order | { league_id, order?: uuid[] } | { draft_session: DraftSession } | Omit order for random generation. |



## 7.6 Supabase Realtime Events


| Channel | Event | Payload | Notes |
| --- | --- | --- | --- |
| draft:{session_id} | PICK_MADE | { pick, next_pick_number, active_user_id, available_player_ids_removed: uuid[] } | All clients |
| draft:{session_id} | TIMER_UPDATE | { pick_number, time_remaining_seconds } | All clients |
| draft:{session_id} | DRAFT_COMPLETE | { session } | All clients. Supersedes TIMER_UPDATE. PICK_MADE fires first on terminal pick, then DRAFT_COMPLETE. Client discards all timer state. |
| draft:{session_id} | TIMER_EXTENDED | { pick_number, new_deadline: timestamptz } | All clients |
| queue:{session_id}:{user_id} | QUEUE_UPDATED | { queue: DraftQueue[] } | Owner only via Supabase Realtime RLS-filtered broadcast. Must be explicitly configured. |
| league:{league_id} | SCORES_UPDATED | { leaderboard: LeaderboardSnapshot[] } | All league members |
| league:{league_id} | ROSTER_UPDATED | { user_id, roster: RosterSlot[] } | All league members |
| league:{league_id} | SYNC_STATUS_CHANGED | { stats_sync_status } | All league members |



# 8. Demo & Portfolio Mode


## 8.1 Seeded Demo League

is_demo = true league: 8 fake participants, 2026 draft, scores through Elite 8, one substitution event, 2 prior seasons.
Seed script: scripts/seed-demo-league.ts. Idempotent. Service role key. DEMO_LEAGUE_ID in env vars.


## 8.2 Demo Session — Anonymous Auth

POST /api/demo/session — supabase.auth.signInAnonymously()
Server attaches demo_viewer JWT claim via Edge Function (set-demo-claim).
Token stored in memory (not localStorage). RLS blocks all mutations via AND NOT (auth.jwt() ->> 'role' = 'demo_viewer').

Enable Supabase native anonymous user auto-deletion: Auth > Settings > Anonymous sign-ins > Auto-delete after 24 hours.


## 8.3 Mock Draft Mode

Client-side only. Zero database writes. All state in React state.
AI Advisor passes player pool state directly in API call.


# 9. Environment Strategy


## 9.1 Overview


| Environment | ESPN API | Supabase | Cron Jobs | Migrations |
| --- | --- | --- | --- | --- |
| local | MOCK_ESPN=true | Local CLI (supabase start) | Manual via ts-node | supabase db push |
| preview | MOCK_ESPN=true | Shared staging project | Disabled | supabase db push on deploy |
| staging | ESPN live | Dedicated project | Enabled, reduced schedule | supabase db push on deploy |
| production | ESPN live | Production project | Full schedule | supabase db push on deploy |



## 9.2 Local Setup

npm install -g supabase
supabase start
supabase db push
ts-node scripts/seed-demo-league.ts
ts-node scripts/seed-players-2026.ts
npm run dev (MOCK_ESPN=true in .env.local)


## 9.3 Migration Strategy

Hand-written SQL in supabase/migrations/ (YYYYMMDDHHMMSS_description.sql). supabase db push applies. Never edit existing files.


## 9.4 Environment Variables


| Variable | Local | Preview | Prod | Notes |
| --- | --- | --- | --- | --- |
| NEXT_PUBLIC_SUPABASE_URL | Local | Staging | Production |  |
| NEXT_PUBLIC_SUPABASE_ANON_KEY | Local | Staging | Production | Safe to expose. RLS is security. |
| SUPABASE_SERVICE_ROLE_KEY | Local | Staging | Production | Never client-exposed. |
| MOCK_ESPN | true | false | false |  |
| ANTHROPIC_API_KEY | Dev | Dev | Production |  |
| RESEND_API_KEY | Test | Test | Live | Test never sends real emails |
| DEMO_LEAGUE_ID | Local uuid | Staging uuid | Production uuid | Set after seed script |
| CRON_SECRET | Any | Any | Secret | API route verifies Authorization: Bearer {CRON_SECRET} |



# 10. Phased Build Plan

Interview answer: 'I scoped the draft engine as one week and it took three. Here is what I underestimated about the concurrency model and the token refresh edge case.'


| Phase | Deliverable | Timeline |
| --- | --- | --- |
| Week 1 | Repo + Supabase local setup + full schema with all indexes + RLS policies + cron_locks table + ROUND_STAGE_ORDER and SCORING_AFFECTING_SETTINGS constants + seed 2026 player data + Google + email auth. Deployed to Vercel. | 1 week |
| Weeks 2–4 | DraftEngine: concurrency model, snake order algorithm, position enforcement (server-side 422), timer, auto-pick including terminal pick edge case, Realtime broadcast, JWT refresh heartbeat. | 2–3 weeks |
| Week 5 | ScoreAccumulator (all 3 trigger paths) + BenchOrderService + RosterActivationService (both activation_timing branches, failure alerting) + roster management UI + leaderboard (scoring_events + snapshots + per-round breakdown). | 1 week |
| Week 6 | Sync job (all 3 responsibilities including bench lock enforcement and end_of_round detection) + ESPN adaptive polling + cron_locks + fallback runbook + commissioner tools. | 1 week |
| Week 7 | AI draft advisor + standings narrator + mock draft mode. | 1 week |
| Week 8 | Demo league seed script + anonymous demo session + historical rankings + email notifications + invite flow. | 1 week |
| Week 9+ | Polish + README + Loom demo video. | Ongoing |



# 11. Scaling Plan — From Family App to 1M DAU


## 11.1 What Breaks First


| Component | Breaks At | Fix |
| --- | --- | --- |
| Postgres connections | ~500 concurrent serverless functions | PgBouncer — Supabase config change |
| Supabase Realtime | ~10K concurrent WebSocket connections | Ably via RealtimeProvider abstraction |
| ScoreAccumulator cron | ~1K simultaneous leagues | BullMQ on Redis — service code identical |
| scoring_events SUM | ~100K concurrent leaderboard requests | Switch to leaderboard_snapshots O(1) — already in schema |
| Vercel Cron single instance | ~500 leagues with active games | Distributed workers |



## 11.2 Auth Migration: Supabase → IAM

external_auth_id column is the hook. New signups populate it. Background job migrates existing users. RLS policies switch to new JWT claim. Deprecate Supabase auth. Business logic never calls auth.uid() directly.


## 11.3 Realtime Migration

RealtimeProvider interface. AblyRealtimeProvider implements same events. Config-layer swap. No component changes.


## 11.4 Job Queue Migration

Vercel Cron → BullMQ + Upstash Redis. One job per active league per round. ScoreAccumulator code identical.


## 11.5 What Holds Up

league_id sharding key on every table
Append-only patterns — no write contention
Settings JSONB — no schema migrations for rule changes
Standard Postgres — portable to Aurora or Cloud Spanner
leaderboard_snapshots O(1) in schema from day one
StatsProvider interface — provider swap is config change
ROUND_STAGE_ORDER constant — new tournament formats require no DB migrations


# 12. Architecture Decisions Log

Read each question as if a senior engineer just asked it across a whiteboard. Answer without referencing this document.

Why append-only roster_slots and draft_picks?
A mutable roster cannot answer 'who was active in slot G1 during Round 2?' without additional audit tables. The append-only log answers this natively via acquired_at_round_stage and released_at_round_stage filtering. Corrections, injury subs, trades, waivers all work without schema changes. The partial unique index on (league_id, user_id, slot_key) WHERE is_active=true catches double-activation at the database level. Tradeoff: more complex current-state queries — mitigated by the is_active boolean index.
Why ROUND_STAGE_ORDER as a constant array instead of a DB enum or integer column?
A Postgres enum requires ALTER TYPE for new values — a production migration. An integer column needs a lookup table and a join. A constant array in the service layer means adding a new stage is a one-file change to constants/rounds.ts. All comparison and next-stage logic picks up the change via indexOf. Historical data is unaffected. Tradeoff: ordering defined in code not database — mitigated by Zod schema validation.
Why store game rules as JSONB?
The family changes rules year over year. Typed columns require schema migrations. JSONB means rule changes are data updates the commissioner makes from the UI. Tradeoff: no DB-level type enforcement — mitigated by Zod validation at application layer.
Why a StatsProvider interface?
ESPN unofficial has no SLA and is rate-limited during March Madness. Swapping to SportsRadar: implement SportsRadarStatsProvider, run ID mapping script, update one settings field. Same pattern for RealtimeProvider — Ably is a config-layer swap not a component rewrite.
Why RLS as primary enforcement?
Application checks are a single point of failure. RLS is enforced by the database regardless of how the query arrives. For multi-tenant isolation, defense in depth is not optional. The self-join security note is critical: the league_members INSERT policy is permissive at the RLS layer — application invite token validation is required and must not be skipped.
Why server-side position enforcement?
Client enforcement is cosmetic and can be stale or manipulated. Server validates on every submission using current database state. Returns typed 422 body { error, message, unfilled_positions } so the frontend has a contract.
Why database-level concurrency model?
In serverless, no shared memory across instances. Application locks don't work. UNIQUE constraint on (draft_session_id, pick_number) and optimistic lock on current_pick_number are enforced by the database. cron_locks uses the same principle: atomic upsert with ON CONFLICT DO UPDATE WHERE for stale lock override.
Why scoring_events is a regular table not a materialized view?
Materialized views refresh fully or not at all. This system needs partial refresh by game_score_id on corrections. Regular table with single-writer discipline and is_stale flag gives full control. SCORING_AFFECTING_SETTINGS constant defines which settings changes trigger full re-run vs. which are query-time.
Why is_stale set atomically with the invalidating write?
Any gap between the score write and the staleness flag means users see wrong scores with no indicator. Atomic writes eliminate this window. Both game_scores writes and roster_slots writes set is_stale in the same transaction.
Why partial indexes for draft_picks and roster_slots?
(draft_session_id, player_id) WHERE voided_at IS NULL: standard UNIQUE breaks the commissioner correction workflow (voiding + re-drafting same player). (league_id, user_id, slot_key) WHERE is_active=true AND released_at_round_stage IS NULL: prevents double-activation that the append-only pattern alone cannot guarantee at the database level.
Why immediate activation as default?
Matches family spreadsheet behavior and participant expectations. Bench player can score same day on a different team. ScoreAccumulator handles correctly via per-game_score_id evaluation. end_of_round is available for families who prefer predictable activation timing.
Why void-without-replacement not supported in v1?
Voiding creates a gap at pick_number N. current_pick_number is used for optimistic locking and snake order computation. A missing pick at N while current_pick_number > N causes incorrect results for all subsequent picks. Replacement must be provided atomically.
Why anonymous auth for demo sessions?
A shared session issued to concurrent visitors risks token conflicts and session invalidation. Anonymous auth gives each visitor their own session with the demo_viewer JWT claim. RLS policies work identically. Tradeoff: auth.users accumulation — mitigated by Supabase's native 24-hour auto-deletion.
Why not MongoDB or Kafka?
Postgres JSONB gives document-store flexibility with ACID and RLS. MongoDB adds a second database with consistency risk. Kafka is built for millions of events per second. BullMQ on Redis is correct at ~1K concurrent leagues; Kafka at 100K+. Using either to demonstrate familiarity when the problem doesn't warrant it demonstrates poor judgment, not knowledge.
How does the system handle 1M DAU without a rewrite?
Infrastructure providers break, not the data model or business logic. PgBouncer for connections (config change). Ably via RealtimeProvider (no component changes). BullMQ for ScoreAccumulator (service code identical). leaderboard_snapshots for O(1) leaderboard (one query change, table in schema from day one). external_auth_id for IAM migration (RLS policy update only). ROUND_STAGE_ORDER means new tournament formats need no DB migrations. None of these touch data model or business logic.
Why Next.js instead of a separate FastAPI backend?
Two deployments, CORS, separate environment management. Next.js API routes are sufficient for this complexity. Service layer architecture means extracting a dedicated backend later is straightforward — service classes move, API contract stays. For a portfolio project, shipping a complete full-stack product in a single repo is more impressive than microservices the problem size doesn't warrant.


# 13. Key Design Tradeoffs

This section captures the most significant tradeoffs made during the design process. Each represents a real choice between competing concerns, with explicit reasoning for why the chosen approach was worth the cost. These are the decisions a hiring manager is most likely to probe.

Supabase over a self-managed Postgres + custom auth stack
✔ Chosen: Supabase managed Postgres with built-in Auth, RLS, and Realtime
⚠ Tradeoff: Less control over infrastructure, vendor lock-in risk at scale, Supabase's free/pro tier limits are real (500MB database, connection limits). Realtime is not designed for millions of concurrent WebSocket connections.
→ Why worth it: For a solo developer building a portfolio project that needs to actually work and be demonstrable quickly, Supabase eliminates weeks of infrastructure setup. The external_auth_id migration hook and the RealtimeProvider abstraction mean the lock-in is limited to infrastructure providers, not data models or business logic. The database is standard Postgres and portable to Aurora or Cloud Spanner when warranted.
Next.js API routes over a separate FastAPI backend
✔ Chosen: Next.js API routes (unified repo, single deployment)
⚠ Tradeoff: FastAPI would leverage existing Python experience and gives cleaner separation of concerns. With Next.js, the backend and frontend share a deployment, making it harder to scale them independently if traffic patterns diverge.
→ Why worth it: For this application's complexity level, the operational overhead of two deployments (CORS, separate environment management, two CI pipelines) outweighs the separation benefits. The service layer architecture means extracting a dedicated backend later is straightforward — service classes move, the API contract stays the same. Shipping a working product matters more than architectural purity at this stage.
Append-only roster_slots over mutable rows
✔ Chosen: Append-only: new rows inserted for every state change, old rows never updated or deleted
⚠ Tradeoff: More complex queries for current state. More rows in the table over time. Requires careful discipline to never update existing rows — a mistaken UPDATE corrupts the audit trail silently.
→ Why worth it: The audit trail is not optional for this application. 'Who was active when?' is the core question ScoreAccumulator answers. A mutable row cannot answer it without additional audit tables. The partial unique index on (league_id, user_id, slot_key) WHERE is_active=true catches the main discipline failure (double-activation) at the database level. The query complexity is mitigated by the is_active boolean index.
scoring_events as a regular table over a Postgres materialized view
✔ Chosen: Regular table written exclusively by ScoreAccumulator, with is_stale flag for staleness signaling
⚠ Tradeoff: We own consistency — if ScoreAccumulator has a bug, scoring_events can have wrong data with no database-level protection. A materialized view would be database-managed. The single-writer discipline requires ongoing code discipline, not a schema constraint.
→ Why worth it: Postgres materialized views refresh fully or not at all. This system needs partial refresh by game_score_id when a correction happens mid-tournament. A regular table with single-writer discipline gives full control over what gets re-computed and when. The is_stale flag set atomically with the writes that invalidate data provides the staleness signal without a full refresh. The SCORING_AFFECTING_SETTINGS constant defines exactly which changes trigger a full vs. partial re-run.
ROUND_STAGE_ORDER constant array over a database enum or integer lookup table
✔ Chosen: Ordered array in src/lib/constants/rounds.ts, imported by all services. indexOf() for comparisons.
⚠ Tradeoff: Ordering defined in code rather than the database. A developer who adds a new stage to the database without updating the constant will have a runtime error, not a schema error. The constant must be kept in sync with the valid values in the Zod schema.
→ Why worth it: A Postgres enum requires ALTER TYPE to add new values — a production migration with coordination overhead. An integer lookup table requires a join on every stage comparison. The constant array approach means adding 'play_in_1' and 'play_in_2' is a one-file change. All comparison and next-stage logic across all services picks up the change automatically. Zod schema validation ensures only known stage values reach the database, providing the same protection as an enum at the application layer.
JSONB settings column over typed columns for league rules
✔ Chosen: Single jsonb settings column on leagues table, validated by Zod schema at application layer
⚠ Tradeoff: No database-level type enforcement on the settings object. A settings write that bypasses the application layer (e.g. direct database edit) can write invalid data. Querying inside a jsonb column for filtering requires GIN indexes — not needed for this use case but worth knowing.
→ Why worth it: The family changes rules year over year. Typed columns require schema migrations for every rule change. JSONB means the commissioner can update rules from the UI, and the application is the only writer. The SCORING_AFFECTING_SETTINGS constant ensures the right services are re-triggered when scoring-relevant settings change. Zod validation at the API layer is the enforcement mechanism.
Database-level concurrency model over application-level locking
✔ Chosen: UNIQUE constraint on (draft_session_id, pick_number) + optimistic lock on current_pick_number + cron_locks atomic upsert
⚠ Tradeoff: More complex to reason about than a simple mutex. The optimistic lock means clients get 409s they have to handle gracefully. The cron lock requires precise SQL (the exact ON CONFLICT ... WHERE clause) — a subtle mistake in the upsert logic would allow concurrent execution.
→ Why worth it: In serverless environments, multiple function instances run simultaneously with no shared memory. Application-level mutexes don't work across instances. The database is the only shared state across all function instances, making it the correct place for coordination. The exact cron lock SQL is documented verbatim in Section 3.18 precisely to prevent the subtle mistake from happening.
RLS as primary security enforcement over application-level checks only
✔ Chosen: RLS policies on every league-scoped table, with application checks as a secondary safeguard
⚠ Tradeoff: RLS policies add a small overhead to every query. Complex policies are harder to test than application code. Local development with Supabase CLI requires explicit auth context setup in tests.
→ Why worth it: Application-level checks are a single point of failure — a bug in middleware, a missed check on a new route, or a direct API call bypasses them. RLS is enforced by the database engine regardless of how the query arrives. For a multi-tenant app where family A must never see family B's data, this is not optional. RLS also enables the demo session security model without any application-layer changes.
Partial unique indexes over standard unique indexes for correctable constraints
✔ Chosen: PARTIAL UNIQUE on (draft_session_id, player_id) WHERE voided_at IS NULL; PARTIAL UNIQUE on (league_id, user_id, slot_key) WHERE is_active=true AND released_at_round_stage IS NULL
⚠ Tradeoff: Partial indexes are less commonly understood than standard unique indexes. A developer unfamiliar with them might try to replace them with standard unique indexes, which would silently break the commissioner correction workflow (a player could no longer be voided and re-drafted).
→ Why worth it: A standard unique index on (draft_session_id, player_id) would prevent re-drafting a player after their pick is voided, which is exactly the correction scenario the commissioner needs. The partial index only enforces uniqueness on non-voided rows — the active set. This is documented explicitly in the index strategy table with the reason, so future developers understand the constraint's intent.
ESPN unofficial API over a paid stats provider for v1
✔ Chosen: ESPN unofficial API (free, no SLA) with SportsRadar as the documented upgrade path
⚠ Tradeoff: ESPN unofficial has no SLA, is not officially supported, and actively rate-limits scrapers during March Madness — the highest-traffic sports event of the year. It could break or be shut down at any time. The operational fallback (manual commissioner entry) is functional but not seamless.
→ Why worth it: For a portfolio project and family use case, paying for SportsRadar (~$150/month) before validating the product is premature. The StatsProvider adapter pattern means the swap is implement SportsRadarStatsProvider + run ID mapping script + update one settings field. The ESPN fallback runbook (Section 4.6) ensures the app degrades gracefully rather than breaking silently when ESPN is unavailable.
Mock ESPN env var over MSW for server-side test mocking
✔ Chosen: MOCK_ESPN=true environment variable checked in ESPNStatsProvider.ts before any HTTP calls, returning fixture data from src/mocks/fixtures/espn/
⚠ Tradeoff: MSW is more sophisticated and can mock at the HTTP layer rather than the service layer, which would catch more integration scenarios. The env var approach means the StatsProvider interface must be tested separately to verify the mock and real implementations are compatible.
→ Why worth it: MSW (Mock Service Worker) intercepts browser-side fetch calls but does not intercept server-side Node.js HTTP calls by default. The Vercel Cron sync jobs run server-side. MOCK_ESPN=true is a simpler, more explicit approach that works for both browser and server-side code without additional configuration. It's also immediately understandable to any developer reading the code.
Anonymous Supabase auth for demo sessions over a shared demo user
✔ Chosen: Per-visitor anonymous Supabase auth session with demo_viewer JWT claim via Edge Function
⚠ Tradeoff: Anonymous auth creates real rows in auth.users. At scale with millions of demo visitors, without cleanup, this table grows unbounded. Requires Supabase's native auto-deletion setting to be configured.
→ Why worth it: A shared auth session issued to multiple concurrent visitors risks token conflicts. If Supabase invalidates a session when a new device signs in with the same credentials, concurrent demo visitors get kicked out mid-session — a bad experience for a hiring manager demo. Anonymous auth gives each visitor their own ephemeral session. The auto-deletion setting (Auth > Settings > Anonymous sign-ins > Auto-delete after 24 hours) is a single configuration change that solves the accumulation problem.
Void-without-replacement not supported in v1
✔ Chosen: replacement_player_id is required in PATCH /api/commissioner/pick/void
⚠ Tradeoff: Reduces commissioner flexibility. If a commissioner wants to void a pick and think about the replacement before committing, they cannot. This could be frustrating during a live draft where time pressure is real.
→ Why worth it: Voiding creates a gap at pick_number N in the draft record. current_pick_number is used for optimistic locking and snake order computation. A missing pick at N while current_pick_number > N causes incorrect results for all subsequent picks. The replacement must be provided atomically in the same operation to maintain draft integrity. V2 can support deferred replacement with additional state management if the family finds the v1 constraint too limiting.
End of Design Document — v8.0 Final

---

# 14. Commissioner Demo Provisioning

## 14.1 Overview

The "Try as Commissioner" feature provisions a personal demo league for each visitor who clicks the CTA on the landing page. The visitor gets a real anonymous Supabase session, becomes the commissioner of a fully seeded demo league (with AI-controlled opponents and a completed tournament through Elite 8), and can experience all commissioner tools, the draft room, the leaderboard, and roster management — without creating an account.

**Design decisions:**
- No idempotency check — each click provisions fresh. Double-clicks create two sessions; cleanup handles orphans within 24h.
- No runtime leaderboard calibration — fixture pre-calibrated offline.
- Rate limiting deferred — button disabled client-side after first click.
- Option A on demo_viewer: provisioned users get full write access to their own league. No demo_viewer claim.
- Orphan check queries auth.users directly (SECURITY DEFINER) — bypasses cascade question entirely.
- Once a commissioner session exists, "View demo standings" CTA replaced with "Return to your league →".

---

## 14.2 Client State Shape

```typescript
// Stored at app level (React context or Zustand) — NOT local component state.
// App-level storage ensures demoSession persists across navigation within the session.
// Both demo flows write to this same slot. Most recent token always overwrites.
interface DemoSession {
  access_token: string
  expires_at: string
  league_id?: string         // set after provisioning, undefined for read-only demo session
  draft_session_id?: string  // set after provisioning
}
```

Render "Return to your league →" only when `demoSession.league_id` is defined.

---

## 14.3 New Endpoint: POST /api/demo/provision

**Auth:** None required.

**Response shape:**
```typescript
{ league_id: string, draft_session_id: string, access_token: string, expires_at: string }
```

**Flow:**
1. `supabase.auth.signInAnonymously()` server-side
2. Do NOT attach demo_viewer claim
3. `DemoProvisioningService.provision(user_id)`
4. Return `{ league_id, draft_session_id, access_token, expires_at }`

**SECURITY DEFINER note:** `provision_demo_league` RPC callable by any authenticated user via PostgREST. Accepted risk — only creates `is_demo = true` leagues with no access to real data.

---

## 14.4 New Utility: src/lib/utils/shuffle.ts

```typescript
// Fisher-Yates shuffle — uniformly random.
// Do NOT use Array.sort(() => Math.random() - 0.5) — not uniformly random.
export function fisherYatesShuffle<T>(array: T[]): T[] {
  const arr = [...array]  // copy — does not mutate input
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}
```

---

## 14.5 New Migrations (4 files)

### Migration 1: TIMESTAMP_add_is_ai_member.sql
```sql
ALTER TABLE users ADD COLUMN is_ai_member BOOLEAN NOT NULL DEFAULT false;
```

### Migration 2: TIMESTAMP_provision_demo_league.sql
```sql
CREATE OR REPLACE FUNCTION provision_demo_league(
  p_commissioner_id UUID,
  p_ai_member_ids UUID[],
  p_ai_display_names TEXT[],
  p_draft_order UUID[],
  p_season INT
)
RETURNS TABLE(league_id UUID, draft_session_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_league_id UUID;
  v_session_id UUID;
  i INT;
BEGIN
  INSERT INTO leagues (name, season, commissioner_id, is_demo, settings)
  VALUES (
    'Your Demo League', p_season, p_commissioner_id, true,
    '{"draft_type":"snake","pick_timer_seconds":90,"starter_slots":{"G":2,"F":2,"C":1},"bench_slots":3,"sub_eligibility_matrix":{"G":["G","F"],"F":["G","F"],"C":["C"]},"bench_lock_mode":"before_first_game","activation_timing":"immediate","injury_sub_enabled":false,"tiebreaker_strategies":["highest_single_active_game"],"scoring_includes_play_in":true,"stats_provider":"espn"}'::jsonb
  )
  RETURNING id INTO v_league_id;

  -- Commissioner row: update display_name only if not already set
  -- (auth trigger may have already created this row on signInAnonymously)
  INSERT INTO users (id, display_name, is_ai_member, created_at)
  VALUES (p_commissioner_id, 'You (Commissioner)', false, now())
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name
    WHERE users.display_name IS NULL;

  -- AI member rows (is_ai_member = true required for cleanup job)
  FOR i IN 1..array_length(p_ai_member_ids, 1) LOOP
    INSERT INTO users (id, display_name, is_ai_member, created_at)
    VALUES (p_ai_member_ids[i], p_ai_display_names[i], true, now())
    ON CONFLICT (id) DO NOTHING;
  END LOOP;

  INSERT INTO league_members (league_id, user_id, role, draft_order_position, joined_at)
  VALUES (v_league_id, p_commissioner_id, 'commissioner',
    array_position(p_draft_order, p_commissioner_id), now());

  FOR i IN 1..array_length(p_ai_member_ids, 1) LOOP
    INSERT INTO league_members (league_id, user_id, role, draft_order_position, joined_at)
    VALUES (v_league_id, p_ai_member_ids[i], 'member',
      array_position(p_draft_order, p_ai_member_ids[i]), now());
  END LOOP;

  -- scheduled_start: now() - 1 minute so Start Draft validation passes immediately
  -- bench_lock_deadline: hardcoded — no real games to derive from. Intentional.
  -- snake_order: empty — populated when commissioner clicks Start Draft
  INSERT INTO draft_sessions (
    league_id, season, status, draft_type, scheduled_start,
    snake_order, current_pick_number, pick_timer_seconds, bench_lock_deadline
  )
  VALUES (
    v_league_id, p_season, 'scheduled', 'snake',
    now() - interval '1 minute', '{}', 1, 90,
    now() + interval '7 days'
  )
  RETURNING id INTO v_session_id;

  RETURN QUERY SELECT v_league_id, v_session_id;
END;
$$;
```

### Migration 3: TIMESTAMP_get_orphaned_demo_league_data.sql
```sql
-- Requires function owner (postgres role) to have SELECT on auth.users.
-- In Supabase this is true by default. Verify on custom Postgres setups.
CREATE OR REPLACE FUNCTION get_orphaned_demo_league_data()
RETURNS TABLE(league_id UUID, ai_member_user_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
    SELECT l.id AS league_id, lm.user_id AS ai_member_user_id
    FROM leagues l
    JOIN league_members lm ON lm.league_id = l.id
    JOIN users u ON u.id = lm.user_id
    WHERE l.is_demo = true
      AND u.is_ai_member = true
      -- Query auth.users directly: authoritative source for anonymous user deletion.
      -- Does not depend on cascade from auth.users to public.users.
      AND NOT EXISTS (SELECT 1 FROM auth.users au WHERE au.id = l.commissioner_id)
      AND NOT EXISTS (
        SELECT 1 FROM draft_sessions ds
        WHERE ds.league_id = l.id AND ds.status = 'live'
      );
END;
$$;
```

### Migration 4: TIMESTAMP_delete_orphaned_demo_leagues.sql
```sql
CREATE OR REPLACE FUNCTION delete_orphaned_demo_leagues(p_league_ids UUID[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- p_league_ids must not be empty; empty array is a no-op (safe but unintended).
  -- Cascade deletes: league_members, draft_sessions, roster_slots, scoring_events,
  -- leaderboard_snapshots, bench_orders, draft_queues, timer_extensions, league_notifications.
  -- NOTE: game_scores NOT deleted — player-scoped, shared across leagues.
  -- NEVER add a FK from game_scores to leagues.
  DELETE FROM leagues WHERE id = ANY(p_league_ids);
END;
$$;
```

---

## 14.6 New Service: src/lib/services/DemoProvisioningService.ts

```typescript
import { v5 as uuidv5 } from 'uuid'
import { fisherYatesShuffle } from '@/lib/utils/shuffle'

const DEMO_MEMBER_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

const AI_MEMBER_NAMES = [
  'Coach Bot', 'Draft King', 'Bracket Buster', 'Rim Protector',
  'Three Point Specialist', 'Paint Enforcer', 'Full Court Press'
]

async provision(commissioner_user_id: string): Promise<{
  league_id: string
  draft_session_id: string
}> {
  const aiMemberIds = AI_MEMBER_NAMES.map(name =>
    uuidv5(`${commissioner_user_id}:${name}`, DEMO_MEMBER_NAMESPACE)
  )
  const shuffledOrder = fisherYatesShuffle([commissioner_user_id, ...aiMemberIds])

  // Step 0: Create AI member auth.users rows (outside transaction — admin API)
  // Any error including duplicate ID: fail immediately, do not recover.
  const createdAiIds: string[] = []
  try {
    for (let i = 0; i < AI_MEMBER_NAMES.length; i++) {
      const { error } = await supabaseAdmin.auth.admin.createUser({
        id: aiMemberIds[i],
        email: `ai-${aiMemberIds[i]}@demo.invalid`,
        user_metadata: { display_name: AI_MEMBER_NAMES[i], is_ai_member: true }
      })
      if (error) throw error
      createdAiIds.push(aiMemberIds[i])
    }
  } catch (error) {
    for (const id of createdAiIds) {
      await supabaseAdmin.auth.admin.deleteUser(id).catch(() => {})
    }
    throw error
  }

  // Steps 1, 2, 4: Atomic Postgres transaction via RPC
  let league_id: string
  let draft_session_id: string
  try {
    const { data, error } = await supabaseAdmin.rpc('provision_demo_league', {
      p_commissioner_id: commissioner_user_id,
      p_ai_member_ids: aiMemberIds,
      p_ai_display_names: AI_MEMBER_NAMES,
      p_draft_order: shuffledOrder,
      p_season: 2026
    })
    if (error) throw error
    league_id = data[0].league_id
    draft_session_id = data[0].draft_session_id
  } catch (error) {
    for (const id of createdAiIds) {
      await supabaseAdmin.auth.admin.deleteUser(id).catch(() => {})
    }
    throw error
  }

  // Step 3: Seed in-season tournament state (idempotent upserts, outside transaction)
  try {
    await seedDemoLeagueData(
      supabaseAdmin, league_id, shuffledOrder, commissioner_user_id, 2026
    )
  } catch (error) {
    // Transaction committed — explicitly clean up committed rows
    await supabaseAdmin.from('leagues').delete().eq('id', league_id).catch(() => {})
    for (const id of createdAiIds) {
      await supabaseAdmin.auth.admin.deleteUser(id).catch(() => {})
    }
    throw error
  }

  return { league_id, draft_session_id }
}
```

---

## 14.7 Extract Shared Seeding Logic: src/lib/utils/seedDemoData.ts

**Required first:** Audit `scripts/seed-demo-league.ts` for hardcoded round stage strings. Replace all with `ROUND_STAGE_ORDER.indexOf()` from `src/lib/constants/rounds.ts` before extraction.

```typescript
export async function seedDemoLeagueData(
  supabaseAdmin: SupabaseClient,
  league_id: string,
  member_user_ids: string[],     // shuffled — do not assume commissioner position
  commissioner_user_id: string,  // explicit — never derived from array position
  season: number                 // must match fixture file season (2026)
): Promise<void>
```

**Seeds via idempotent upserts:**

**1. Completed draft session for historical data:**
- `status: 'complete'`, `draft_type: 'snake'`
- `scheduled_start: now() - 30 days - 1 hour`
- `started_at: now() - 30 days`
- `completed_at: now() - 30 days + 2 hours`
- `snake_order: member_user_ids` — matches draft_picks order, same as new draft's eventual order (both derived from shuffledOrder) — intentional
- `current_pick_number: 65` — (8 members × 8 roster slots) + 1, hardcoded for fixed demo config
- `pick_timer_seconds: 90`
- `bench_lock_deadline: now() - 28 days`

This is separate from the Step 4 'scheduled' session. Commissioner page uses it for historical draft replay.

**2.** Snake draft picks (64) via survival-score × avg_ppg

**3.** `roster_slots` with `acquired_at_round_stage = 'draft'` (exact string sentinel)

**4.** `game_scores` for rounds play_in through e8:
- Point values pre-calibrated in fixture file — do not adjust at runtime
- Fixture uses `season: 2026` — season parameter must match or UPSERT inserts duplicates
- Calibration targets provisioned league (shuffled order); static demo league may have different spread — acceptable for read-only showcase

**5.** Call `ScoreAccumulator.runForLeague(league_id)` after all game_scores upserted. `runForLeague()` always performs full recompute and does NOT gate on `is_stale`. Add comment in ScoreAccumulator.ts: `// runForLeague() always performs full recompute regardless of is_stale.`

**6.** Never write `scoring_events` directly. ScoreAccumulator is the only writer.

**7.** At least one substitution event: team eliminated in r64, bench player activated with `acquired_at_round_stage = 'r32'`

---

## 14.8 New Daily Cleanup Cron: GET /api/cron/demo-cleanup

**Vercel.json addition:**
```json
{ "path": "/api/cron/demo-cleanup", "schedule": "0 3 * * *" }
```

**Cron auth:** Verify `Authorization: Bearer {CRON_SECRET}`.

**Cron lock:** `job_name: 'demo_cleanup'`. Acquire using exact SQL from Section 3.18. Separate from `score_sync`. Release via `releaseCronLock` helper in ALL exit paths.

**Concurrent runs are safe** — league DELETE is idempotent, auth deletion errors swallowed.

**Scale note:** ~7 auth deletions per league. 10-minute lock handles ~80 leagues. Not a concern for v1.

```typescript
// releaseCronLock helper
async function releaseCronLock(jobName: string): Promise<void> {
  await supabaseAdmin
    .from('cron_locks')
    .delete()
    .eq('job_name', jobName)
    .catch(() => {}) // best effort — 10-minute timeout is the fallback
}

// acquireCronLock helper — uses exact SQL from Section 3.18
// Returns true if lock acquired, false if another instance holds a fresh lock.

// Route handler:

// 1. Verify CRON_SECRET
// 2. acquireCronLock('demo_cleanup') — return 200 { in_progress: true } if not acquired

// 3. Fetch orphaned data
const { data: orphanedData, error: fetchError } = await supabaseAdmin
  .rpc('get_orphaned_demo_league_data')

if (fetchError) {
  console.error('demo-cleanup: failed to fetch orphaned data', fetchError)
  await releaseCronLock('demo_cleanup')
  return new Response(JSON.stringify({ error: fetchError.message }), { status: 500 })
}

if (!orphanedData || orphanedData.length === 0) {
  await releaseCronLock('demo_cleanup')
  return new Response(JSON.stringify({ deleted: 0 }), { status: 200 })
}

// 4. Delete AI member auth.users rows BEFORE deleting leagues
//    (league_members cascade destroys the mapping after league deletion)
const aiMemberIds = [...new Set(
  orphanedData.map((r: { ai_member_user_id: string }) => r.ai_member_user_id)
)]
for (const id of aiMemberIds) {
  await supabaseAdmin.auth.admin.deleteUser(id).catch(() => {})
}

// 5. Delete orphaned leagues
const leagueIds = [...new Set(
  orphanedData.map((r: { league_id: string }) => r.league_id)
)]
const { error: deleteError } = await supabaseAdmin
  .rpc('delete_orphaned_demo_leagues', { p_league_ids: leagueIds })

if (deleteError) {
  console.error('demo-cleanup: failed to delete orphaned leagues', { leagueIds, error: deleteError })
  // AI member auth rows already deleted. Leagues remain but have no AI members.
  // Known edge case: these leagues are permanently un-cleanable by future runs
  // (get_orphaned_demo_league_data joins on is_ai_member = true which no longer exists).
  // Future improvement: add a second cleanup pass for is_demo leagues with no AI members.
  await releaseCronLock('demo_cleanup')
  return new Response(JSON.stringify({ error: deleteError.message }), { status: 500 })
}

await releaseCronLock('demo_cleanup')
return new Response(JSON.stringify({ deleted: leagueIds.length }), { status: 200 })
```

---

## 14.9 Landing Page Changes

**Default state:** Three CTAs shown.

**After provisioning:** Replace "View demo standings" with "Return to your league →" linking to `/commissioner/[demoSession.league_id]` — only rendered when `demoSession.league_id` is defined.

| State | CTA 1 | CTA 2 | CTA 3 |
|-------|-------|-------|-------|
| Default | Try as Commissioner | Try mock draft | View demo standings |
| After provisioning | Try as Commissioner (disabled) | Try mock draft | Return to your league → |

**Button behavior:**
- Disabled immediately on first click (prevents double-provisioning)
- Loading state: "Setting up your league..."
- On success: write `{ access_token, expires_at, league_id, draft_session_id }` to `demoSession`, replace CTA, redirect to `/commissioner/[league_id]`
- On error: re-enable button, show "Something went wrong — try again"

**Commissioner page:** Dismissible yellow banner when `league.is_demo = true`:
> "This is a demo league. You have full commissioner access. Your progress is saved for 24 hours."

**DraftSchedulerPanel:** Pass `showScheduledStart={!league.is_demo}` as a prop. Render the scheduled_start field only when this prop is true.

---

## 14.10 Fixture Pre-Calibration (Offline, One-Time)

Run the seeding algorithm locally against a test database. Inspect the leaderboard spread between top 2 participants. Adjust specific players' game_scores point values in the fixture JSON file until the spread is ≤ 15 points heading into f4. Commit the calibrated fixture file. This is done once before deployment — not runtime logic.



---

# 15. Logged-In User Features (Phase 7A)

## 15.1 Overview

Phase 7A closes functional gaps in the logged-in user experience identified after the initial build (Phases 1-6) and Commissioner Demo Provisioning (Section 14). These features use schema and APIs that already exist — this phase is primarily UI and wiring work with a small number of new routes.

This section is build-ready. All features have been audited to the same standard as the rest of this document. Implement in the order specified in Section 15.3.

---

## 15.2 Pre-Build Verification

Complete all checks before writing any code. Report results before proceeding to implementation.

**Check 1:** Open `src/app/api/commissioner/bench-order/route.ts`. Does the handler enforce commissioner role before executing?
- If allows `user_id = auth.uid()` without commissioner check: use existing route directly for Feature 1. No new route needed.
- If enforces commissioner role: create `PATCH /api/league/[league_id]/bench-order` as specified in Feature 1.

**Check 2:** Open `GET /api/league/[league_id]/roster/[user_id]` route. Confirm SQL select includes `players.injury_status`, `players.injury_note`, `players.injury_updated_at`, and `teams.is_eliminated`. Add any missing fields before building Feature 4.

**Check 3:** Confirm `/app/invite/[token]/page.tsx` or equivalent exists and renders the invite acceptance UI — shows league name, invited-by display name, and "Accept Invite" button calling `POST /api/invite/:token/accept`. If not, build it first.

**Check 4:** Confirm `DraftQueue` component accepts `draft_session_id` as an explicit prop (not only from context). If context-only, extract the prop interface before reusing in Feature 3.

**Check 5:** Confirm league home hub URL includes `league_id` in path or context.

**Check 6:** Confirm `POST /api/draft/queue` validates that the target session's `status` is not `'complete'` before inserting. If not, add: return 422 if `draft_sessions.status = 'complete'` for the given `draft_session_id`.

---

## 15.3 Build Order

1. Pre-build verification (6 checks)
2. League endpoint extension (Section 15.4 — required by Features 1, 2, 3, 9)
3. Invite acceptance page (if missing from Check 3)
4. Feature 4 — injury badge on roster (one-line change)
5. Feature 8 — league rules page (read-only, no new routes)
6. Feature 7 — draft pick void UI + available-players route
7. Feature 2 — bench lock deadline visibility
8. Feature 1 — bench order submission page
9. Feature 3 — pre-draft queue from explorer + My Queue view
10. Feature 5 — post-creation invite management
11. Feature 6 — member role management
12. Feature 9 — dashboard countdowns (optional — cut to Phase 7B if this phase runs long)

---

## 15.4 League Endpoint Extension

Add five new fields to `GET /api/league/[league_id]` before building any features. New fields are additive and do not break existing consumers. Do not create a separate `draft-info` endpoint.

```typescript
// Added to existing league response:
draft_session_id: string | null       // from draft_sessions — needed for Realtime in Feature 3
bench_lock_deadline: string | null    // from draft_sessions
draft_status: 'scheduled' | 'live' | 'complete' | 'cancelled' | null
scheduled_start: string | null
season_in_progress: boolean           // separate query — see below
```

**Implementation — two separate server-side queries (not one):**

```typescript
// Query 1: four fields from draft_sessions
const { data: session } = await supabase
  .from('draft_sessions')
  .select('id, bench_lock_deadline, status, scheduled_start')
  .eq('league_id', league_id)
  .neq('status', 'cancelled')
  .order('created_at', { ascending: false })
  .maybeSingle()

// Query 2: season_in_progress — CANNOT be derived from draft_sessions, requires separate query
const { count } = await supabase
  .from('game_scores')
  .select('id', { count: 'exact', head: true })
  .eq('season', league.season)
  .eq('game_status', 'in_progress')

// Map to response:
draft_session_id: session?.id ?? null
bench_lock_deadline: session?.bench_lock_deadline ?? null
draft_status: session?.status ?? null
scheduled_start: session?.scheduled_start ?? null
season_in_progress: (count ?? 0) > 0
```

`season_in_progress` is computed server-side on every call — never derived client-side by querying `game_scores` directly. Scoped to `leagues.season` to avoid the global unscoped query problem documented in the Phase A bug fixes.

---

## 15.5 Global Implementation Notes

**Authentication:** All new routes use the user's JWT (not service role key). RLS is the primary enforcement layer. Application-layer checks are defense-in-depth only.

**Loading and error states:** Every new page and form must implement: skeleton or spinner while fetching, error toast on any failed API call, form re-enablement after failure. Multi-step forms (Feature 7) preserve all selections on error and allow retry without restarting from step 1.

**Null-safe date comparisons:** Never rely on JavaScript null coercion for date comparisons:
```typescript
// Correct:
const isLocked = deadline != null && new Date(deadline) < new Date()
// Wrong (null coerces to 0, always evaluates as true for positive timestamps):
const isLocked = new Date(deadline) < new Date()
```

**formatCountdown helper:** Define once in `src/lib/utils/formatCountdown.ts`. Only call with future dates — always check `date > new Date()` before calling. For past dates use a static formatter: `format(date, "MMMM d 'at' h:mm a")` from date-fns.

```typescript
import { formatDistanceToNowStrict } from 'date-fns'

export function formatCountdown(date: Date): string {
  const ms = date.getTime() - Date.now()
  if (ms > 24 * 60 * 60 * 1000) {
    return formatDistanceToNowStrict(date, { addSuffix: true, unit: 'day' })
  }
  if (ms > 60 * 60 * 1000) {
    return formatDistanceToNowStrict(date, { addSuffix: true, unit: 'hour' })
  }
  return formatDistanceToNowStrict(date, { addSuffix: true, unit: 'minute' })
}
// Produces: "in 3 days", "in 4 hours", "in 22 minutes"
// Never: "in 2 days, 4 hours, 32 minutes" (too verbose for a widget)
```

**Parallel data fetching:** When a page requires two independent data sources, fetch in parallel with `Promise.all`. Do not await one before starting the other.

---

## 15.6 Feature 1: Participant Bench Order Submission

### Route (conditional on Check 1)

If Check 1 shows the existing bench-order route enforces commissioner role only, create:

```
PATCH /api/league/[league_id]/bench-order
Auth: user JWT

Step 1 — Auth check (single query, result reused — no second league_members query):
  const { data: member } = await supabase
    .from('league_members')
    .select('role')
    .eq('league_id', league_id)
    .eq('user_id', auth.uid())
    .maybeSingle()
  if (!member) return 403

Step 2 — Fetch bench_lock_deadline:
  const { data: session } = await supabase
    .from('draft_sessions')
    .select('bench_lock_deadline')
    .eq('league_id', league_id)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false })
    .maybeSingle()

Step 3 — Lock check (reuse member.role from Step 1 — no second league_members query):
  const isLocked = session?.bench_lock_deadline != null
    && new Date(session.bench_lock_deadline) < new Date()
  const isCommissioner = member.role === 'commissioner'
  if (isLocked && !isCommissioner) {
    return 422 {
      error: 'BENCH_ORDER_LOCKED',
      message: 'Bench order is locked.',
      bench_lock_deadline: session.bench_lock_deadline
    }
  }

Body: { ordered_player_ids: string[] }
Writes: bench_orders upsert on (league_id, user_id):
        ordered_player_ids,
        submitted_at = now(),       // always written — BenchOrderService gates on this
        last_edited_by = auth.uid(),
        last_edited_at = now()
Returns: { bench_order: BenchOrder }
```

### Page: `/league/[league_id]/bench-order`

**Lock state derivation (explicit null check):**
```typescript
const isLocked = bench_lock_deadline != null
  && new Date(bench_lock_deadline) < new Date()
// null → false (always_editable — never locked)
// future date → false
// past date → true
```

**Data fetching:** Fetch league data (includes `draft_status`, `bench_lock_deadline`) and bench player roster data in parallel with `Promise.all`.

**States:**

**Pre-draft (`draft_status !== 'complete'`):** "Your bench order will be available after the draft completes." No drag list, no save button. Using `draft_status` as the signal avoids a race condition where `roster_slots` haven't yet committed after draft completion.

**Post-draft, unlocked (`draft_status = 'complete'` AND `!isLocked`):** Drag-to-reorder list of bench players from `roster_slots WHERE is_bench = true AND is_active = true` joined with players and teams. Each item: player name, position, team, avg PPG, "Eliminated" badge if `teams.is_eliminated = true`. Default order if `submitted_at IS NULL`: sort by `avg_ppg DESC` with note "Default order — drag to customize." Save button. Success toast: "Bench order saved."

**Locked (`draft_status = 'complete'` AND `isLocked`):** Read-only list. Banner: `"Bench order locked on " + format(new Date(bench_lock_deadline), "MMMM d 'at' h:mm a")`. Use static date formatter — not `formatCountdown` (which would produce "3 days ago" for a past date).

**Always-editable mode (`bench_lock_deadline = null`):** Show note: "Your bench order can be changed at any time — there is no lock deadline for this league."

**Link from:** Roster page header, league home hub.

---

## 15.7 Feature 2: Bench Lock Deadline Visibility

**Data source:** `bench_lock_deadline` and `draft_status` from league endpoint extension. No additional fetch.

**Display:**
- `bench_lock_deadline` is null: show nothing
- `new Date(bench_lock_deadline) > new Date()`: "Bench order locks [formatCountdown(new Date(bench_lock_deadline))]"
- `new Date(bench_lock_deadline) <= new Date()`: "Bench order locked"

**Where:** Bench order page (large banner), league home hub (small info line).

---

## 15.8 Feature 3: Pre-Draft Queue from Explorer + My Queue View

### "Add to queue" button on player cards

Visible when `draft_status IN ('scheduled', 'live')`. States:
- Default: "Add to queue" → `POST /api/draft/queue` with `{ draft_session_id, player_id }` where `draft_session_id` comes from league endpoint extension
- Already in queue: "In queue" (disabled)
- Already drafted: "Taken"

### Remove from queue

`DELETE /api/draft/queue/:session_id/:player_id` — `session_id` first path param per Phase 2 implementation. Design doc Section 7.3 is stale on this point — the Phase 2 implementation is correct.

### DraftQueue component

After Check 4, confirm accepts `draft_session_id` as explicit prop. If context-only, extract prop interface first. Reuse as collapsible drawer on `/players`. Visible when `draft_status IN ('scheduled', 'live')`.

### Realtime subscription on /players

`draft_session_id` is available from the league endpoint extension. Fetch-then-subscribe sequence on mount:

1. Fetch league data (includes `draft_status` and `draft_session_id`)
2. If `draft_status = 'live'` AND `draft_session_id` is not null: subscribe to `draft:{draft_session_id}` channel
3. If `draft_status = 'complete'` (draft ended before page loaded): hide queue drawer immediately, do not subscribe
4. If `draft_status = 'scheduled'`: no subscription needed
5. On `DRAFT_COMPLETE` event: unsubscribe, hide queue drawer with toast "Draft complete. Your queue has been cleared."
6. On component unmount: unsubscribe (standard Supabase Realtime cleanup)

### My Queue standalone link

Only show on league home hub when `draft_status IN ('scheduled', 'live')`. Links to `/players?queue=open`. On load: opens queue drawer if active draft exists. If no active draft when param is present: silently ignore, show normal explorer.

---

## 15.9 Feature 4: Injury Status Badge on Roster Page

After Check 2 confirms all fields available:

Reuse existing `InjuryBadge` component on each active roster slot card. Show if `injury_status IN ('day_to_day', 'out')`. On hover/tap: show `injury_note` and `injury_updated_at`. No new routes, no new data fetch.

---

## 15.10 Feature 5: Post-Creation Invite Management

### New route: `GET /api/league/[league_id]/invites`

- Commissioner only (403 otherwise). Co-commissioners do not have access in v1 — intentional.
- Filter: `status IN ('pending', 'expired')` only. Accepted invites appear in the member list, not here.
- Response:
```typescript
{
  invites: Array<{
    id: string,
    invited_email: string,
    status: 'pending' | 'expired',
    sent_at: string,
    accepted_at: string | null,
    token: string,
    invite_url: string  // ${process.env.NEXT_PUBLIC_APP_URL}/invite/${token}
  }>
}
```
- Guard: if `NEXT_PUBLIC_APP_URL` is not set, return 500 `{ error: 'MISSING_ENV', message: 'NEXT_PUBLIC_APP_URL is not configured.' }`. Add `NEXT_PUBLIC_APP_URL` to environment variables table in Section 9.4.
- Security note: `league_invites` RLS allows invitees to read their own row directly. Returning `token` here is acceptable for v1 — tokens are single-use and expire.

### Route: `PATCH /api/invite/:token` (existing route)

- Commissioner only
- Body: `{ status: 'expired' }`

### Resend operation (POST before PATCH to avoid losing valid invite on failure)

1. `POST /api/invite` with `{ league_id, email }` — creates new row, sends email
2. If POST fails: error toast, stop. Old invite still valid.
3. If POST succeeds: `PATCH /api/invite/:old_token` with `{ status: 'expired' }`
4. If PATCH fails: log server-side. Both tokens temporarily valid. Acceptable for family app.

**Critical:** The "Resend" button shows a loading state from the start of the POST until the PATCH completes or fails. It is not re-enabled between the two calls. The `old_token` must be held in local state throughout the operation — a re-render between calls must not lose it.

### Commissioner page section — "League Members & Invites"

Member list: display name, role badge, joined date, Feature 6 role actions.

Pending invites (shown by default): email, sent date, "Pending" badge, "Resend" button, "Cancel" button.

Expired invites (collapsed behind "Show expired (N)" toggle): email, sent date, "Expired" badge, "Resend" button only — Cancel hidden (no-op on already-expired row). Count is derived client-side from the fetched invite list (`filter(i => i.status === 'expired').length`) — do not make a second request for this count.

"Invite member" form: email + Send → `POST /api/invite`.

---

## 15.11 Feature 6: Member Role Management

**Design decision:** Commissioner only for both PATCH and DELETE. Co-commissioners cannot change member roles or remove members. Rationale: co-commissioners creating peer co-commissioners without the commissioner's knowledge is unintended.

### New route: `PATCH /api/league/[league_id]/members/[user_id]`

- RLS note: `league_members UPDATE` policy (Section 6.2) already enforces `commissioner_id = auth.uid()`. App-layer check is defense-in-depth.
- App-layer check: `SELECT role FROM league_members WHERE league_id = ? AND user_id = auth.uid()` must return `'commissioner'` exactly
- Self-targeting guard: if path `user_id` matches `auth.uid()` → 422 `{ error: 'SELF_ROLE_CHANGE', message: 'You cannot change your own role.' }`
- Body: `{ role: 'member' | 'co_commissioner' }`
- Returns updated member row

### New route: `DELETE /api/league/[league_id]/members/[user_id]`

- App-layer check: must return `'commissioner'` exactly — co-commissioners cannot remove members
- Self-targeting guard: if path `user_id` matches `leagues.commissioner_id` → 422 `{ error: 'CANNOT_REMOVE_COMMISSIONER', message: 'The league commissioner cannot be removed.' }`
- Deletes `league_members` row. RLS immediately revokes all league data access for the removed user.
- Returns 204

### UI

Commissioner sees per-member actions:
- Member row: "Promote to co-commissioner", "Remove"
- Co-commissioner row: "Demote to member", "Remove"
- Commissioner row: no actions (self-action blocked at API layer)

Co-commissioners: read-only member list, no role actions, no invite list (GET /api/league/[league_id]/invites returns 403).

**Remove confirmation dialog:**
> "Remove [display name] from the league?
> They will lose access immediately. Their draft picks and scores will remain in the league history.
> [Cancel] [Remove Member]"

**Known v1 limitation:** Members cannot remove themselves (explicit v1 decision, Section 6.2).

---

## 15.12 Feature 7: Draft Pick Void/Replace UI + Available Players Route

### New route: `GET /api/league/[league_id]/available-players`

- Auth: any league member (user JWT, RLS enforces membership)
- Query param validation: if `?position` is present and not in `['G', 'F', 'C']`: return 400 `{ error: 'INVALID_POSITION', message: 'Position must be G, F, or C.' }`
- Supports `?search=` filter on player name

```typescript
// Step 1: most recent completed session
const { data: session } = await supabase
  .from('draft_sessions')
  .select('id')
  .eq('league_id', league_id)
  .eq('status', 'complete')
  .order('completed_at', { ascending: false })
  .maybeSingle()  // returns null if no completed session — never throws

// Step 2: drafted player IDs (only if session exists)
let excludedPlayerIds: string[] = []
if (session) {
  const { data: picks } = await supabase
    .from('draft_picks')
    .select('player_id')
    .eq('draft_session_id', session.id)
    .is('voided_at', null)
  excludedPlayerIds = picks?.map(p => p.player_id) ?? []
}

// Step 3: query players — pass array directly, no string interpolation
let query = supabase.from('players').select('*').eq('season', league.season)
if (excludedPlayerIds.length > 0) {
  query = query.not('id', 'in', excludedPlayerIds)  // array, not string
}
// If no completed session: return all players (no picks to exclude)
// Apply validated ?position and ?search filters
// Returns { players: Player[] }
```

### Existing route modification: `PATCH /api/commissioner/pick/void`

Add at the top of the existing handler (not a new route):
```typescript
const { data: pick } = await supabase
  .from('draft_picks')
  .select('voided_at')
  .eq('id', pick_id)
  .maybeSingle()  // NOT .single() — returns null for missing rows, never throws
if (!pick) return 404 { error: 'PICK_NOT_FOUND', message: 'Pick not found.' }
if (pick.voided_at) return 422 { error: 'PICK_ALREADY_VOIDED', message: 'This pick has already been voided.' }
```

### Commissioner page section — "Correct a Pick"

Only shown when `draft_status = 'complete'`.

**Data source for Step 1 picks list:** Use `GET /api/draft/state/:session_id` (existing endpoint). The `picks` array in the response contains all draft picks. Ignore the `available_players` payload — it is not needed here. Order picks by `round_number ASC, pick_number ASC`. Filter to non-voided only (`voided_at = null`).

**Step 1 — Select pick to void:**
- Picks list ordered `round_number ASC, pick_number ASC`
- Each row: pick number, participant display name, player name, position, team
- Click to select (highlighted). Selection persists through steps 2 and 3.

**Step 2 — Select replacement:**
- Calls `GET /api/league/[league_id]/available-players?position=[voided_player_position]`
- In v1: position filter UI element is not rendered — voided player's position is passed automatically as a query param. DraftEngine position enforcement is the API-layer backstop.
- Search input filters by name.

**Step 3 — Confirm:**
- "Replace [Player A] ([Team A]) with [Player B] ([Team B])?"
- Required void reason (min 1 character, validated client-side before submit)
- Submit → `PATCH /api/commissioner/pick/void`
- On success: "Pick corrected." toast, picks list refreshes, all selections clear
- On failure: error toast, all selections preserved, retry without restarting from Step 1

---

## 15.13 Feature 8: League Rules Read View

### New page: `/league/[league_id]/rules`

Data from `GET /api/league/[league_id]` settings JSONB. No new routes.

**Roster (explicit G→F→C sort order — not insertion order):**
```typescript
const POSITION_ORDER = ['G', 'F', 'C'] as const
const parts = POSITION_ORDER
  .filter(pos => settings.starter_slots[pos] !== undefined)
  .map(pos => {
    const label = pos === 'G' ? 'Guards' : pos === 'F' ? 'Forwards' : 'Centers'
    return `${settings.starter_slots[pos]} ${label}`
  })
const rosterLine = [...parts, `${settings.bench_slots} Bench`].join(' · ')
// e.g. "2 Guards · 2 Forwards · 1 Center · 3 Bench"
```

**Substitution (dynamic from matrix, symmetric rules collapsed, no array mutation):**
```typescript
const POSITION_ORDER = ['G', 'F', 'C']
const groups = new Map<string, string[]>()
for (const [pos, eligible] of Object.entries(settings.sub_eligibility_matrix)) {
  if (eligible.length === 0) continue  // guard: skip misconfigured empty arrays
  const key = JSON.stringify([...eligible].sort())  // spread before sort — no mutation
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key)!.push(pos)
}
// Sort positions within each group by POSITION_ORDER for consistent display
// regardless of sub_eligibility_matrix key insertion order
for (const [key, positions] of groups) {
  groups.set(key, positions.sort((a, b) =>
    POSITION_ORDER.indexOf(a) - POSITION_ORDER.indexOf(b)
  ))
}
// Render each group as one sentence:
// G+F share ['G','F'] → "Guards and Forwards can be replaced by Guards or Forwards"
// C alone with ['C'] → "Centers can only be replaced by Centers"
// Empty eligible: skipped (guard above)
```

**Bench lock:**
- `'before_first_game'` → "Bench orders lock before the first game tips off"
- `'always_editable'` → "Bench orders are always editable"

**Activation:**
- `'immediate'` → "Bench players activate immediately when a starter's team is eliminated"
- `'end_of_round'` → "Bench players activate at the end of each round"

**Scoring:**
- `scoring_includes_play_in = true` → "Play-in games count toward scoring"
- `scoring_includes_play_in = false` → "Play-in games do not count"

**Tiebreaker:**
```typescript
const TIEBREAKER_LABELS: Record<string, string> = {
  highest_single_active_game: 'Highest single-game score by an active player',
  // All currently valid values from Section 4.3 enumerated here.
  // Add new values when new strategies are implemented — do not rely on fallback.
}
const label = TIEBREAKER_LABELS[settings.tiebreaker_strategies[0]]
  ?? `Unknown tiebreaker: ${settings.tiebreaker_strategies[0]}`
```

**Link from:** League home hub as "League Rules."

---

## 15.14 Feature 9: Dashboard Countdown Widgets (Optional)

Cut to Phase 7B if this phase runs long. Build last.

All data from `GET /api/league/[league_id]` — no additional fetches.

**Status line — first match wins:**

1. `draft_status = 'live'` → "Draft in progress →" (link to draft room)
2. `draft_status = 'scheduled'` AND `scheduled_start != null` AND `new Date(scheduled_start) > new Date()` → "Draft starts [formatCountdown(new Date(scheduled_start))]"
3. `draft_status = 'complete'` AND `season_in_progress = true` → "Season in progress"
4. `draft_status = 'complete'` AND `season_in_progress = false` → "Season complete"
5. All other cases → show nothing

**Bench lock status (shown separately below status line):**
- `bench_lock_deadline` is null: show nothing
- `new Date(bench_lock_deadline) > new Date()`: "Bench order locks [formatCountdown(new Date(bench_lock_deadline))]"
- `new Date(bench_lock_deadline) <= new Date()`: "Bench order locked"

All date comparisons use explicit null checks per Section 15.5.

---

## 15.15 What This Phase Does Not Include

- Members cannot remove themselves (explicit v1 decision, Section 6.2)
- Co-commissioners cannot access invite list or change member roles (v1 — commissioner only)
- Bracket visualization (Phase 7B)
- AI superlatives / fun awards (Phase 7B)
- Historical multi-season standings page (Phase 7B)
- Today's Games schedule widget (Phase 7B)
- Draft recap page (Phase 7B)
- Email digest wiring (deferred)
- Mobile push notifications (deferred)
- League chat (removed from scope)
