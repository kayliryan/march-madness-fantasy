/**
 * Core type definitions for March Madness Fantasy
 * Matches database schema and API contracts
 */

// ===== USERS =====
export interface User {
  id: string;
  external_auth_id?: string;
  display_name: string;
  avatar_url?: string;
  bio?: string;
  notification_preferences: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ===== TEAMS & PLAYERS =====
export interface Team {
  id: string;
  season: number;
  name: string;
  /** Mascot-free school name (e.g. "Duke" not "Duke Blue Devils"). Null for the 12 "Historical" region teams. */
  short_name: string | null;
  seed: number;
  region: string;
  is_eliminated: boolean;
  eliminated_in_round_stage?: string;
  eliminated_in_round_number?: number;
  espn_team_id?: string;
  synced_at?: string;
  created_at: string;
  updated_at: string;
}

export interface Player {
  id: string;
  season: number;
  name: string;
  team_id: string;
  position: 'G' | 'F' | 'C';
  position_overridden: boolean;
  position_override_note?: string;
  avg_ppg: number;
  injury_status?: 'active' | 'day_to_day' | 'out';
  injury_note?: string;
  injury_updated_at?: string;
  espn_player_id?: string;
  synced_at?: string;
  created_at: string;
  updated_at: string;
  // Present when fetched with a join to teams (e.g. GET /api/players)
  teams?: Pick<Team, 'id' | 'name' | 'short_name' | 'seed' | 'region'> | null;
}

// ===== LEAGUES =====
export interface LeagueSettings {
  draft_type: 'snake' | 'linear' | 'auction';
  draft_order_lock_days_before: number;
  pick_timer_seconds?: number;
  starter_slots: Record<'G' | 'F' | 'C', number>;
  bench_slots: number;
  sub_eligibility_matrix: Record<'G' | 'F' | 'C', ('G' | 'F' | 'C')[]>;
  bench_lock_mode: 'before_first_game' | 'always_editable';
  activation_timing: 'immediate' | 'end_of_round';
  injury_sub_enabled: boolean;
  // DEFAULT false. Not yet implemented — no re-activation endpoint reads this
  // setting. When implemented, a re-activation endpoint should check this
  // before allowing an injured player to return to their roster slot.
  injury_sub_reversible: boolean;
  tiebreaker_strategies: string[];
  scoring_includes_play_in: boolean;
  stats_provider: 'espn' | 'sportsradar';
  notifications: {
    round_end_email: boolean;
    daily_digest: boolean;
    ai_summary: boolean;
  };
  email_tone: 'playful' | 'formal' | 'casual';
}

export interface League {
  id: string;
  name: string;
  season: number;
  commissioner_id: string;
  settings: LeagueSettings;
  invite_token?: string;
  is_demo: boolean;
  demo_expires_at: string | null;
  stats_sync_status: 'ok' | 'degraded' | 'manual';
  created_at: string;
  updated_at: string;
}

export interface LeagueMember {
  id: string;
  league_id: string;
  user_id: string;
  role: 'member' | 'co_commissioner' | 'commissioner';
  draft_order_position?: number;
  joined_at: string;
  invited_by?: string;
  created_at: string;
  updated_at: string;
}

export interface LeagueInvite {
  id: string;
  league_id: string;
  invited_email: string;
  invited_by: string;
  token: string;
  status: 'pending' | 'accepted' | 'expired';
  sent_at: string;
  accepted_at?: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

// ===== DRAFT =====
export interface DraftSession {
  id: string;
  league_id: string;
  season: number;
  status: 'scheduled' | 'live' | 'complete' | 'cancelled';
  draft_type: 'snake' | 'linear' | 'auction';
  scheduled_start: string;
  started_at?: string;
  completed_at?: string;
  snake_order: string[];
  current_pick_number: number;
  pick_timer_seconds?: number;
  bench_lock_deadline?: string;
  created_at: string;
  updated_at: string;
}

export interface DraftPick {
  id: string;
  draft_session_id: string;
  league_id: string;
  pick_number: number;
  round_number: number;
  user_id: string;
  player_id: string;
  picked_at: string;
  time_taken_seconds?: number;
  was_auto_picked: boolean;
  voided_at?: string;
  voided_by?: string;
  void_reason?: string;
  replaces_pick_id?: string;
  created_at: string;
  updated_at: string;
}

export interface DraftQueue {
  id: string;
  league_id: string;
  draft_session_id: string;
  user_id: string;
  player_id: string;
  queue_position: number;
  added_at: string;
  removed_at?: string;
  created_at: string;
  updated_at: string;
  // Present when fetched with a join to players (queue API responses)
  players?: Player | null;
}

// ===== ROSTER =====
export interface RosterSlot {
  id: string;
  league_id: string;
  user_id: string;
  player_id: string;
  slot_key: string;
  slot_position: 'G' | 'F' | 'C';
  is_active: boolean;
  is_bench: boolean;
  acquired_at_round_stage: string;
  released_at_round_stage?: string;
  release_reason?: 'eliminated' | 'substituted' | 'injury_sub' | 'correction' | 'traded' | 'waiver' | 'draft_cancelled';
  override_by?: string;
  override_reason?: string;
  created_at: string;
  updated_at: string;
}

export interface BenchOrder {
  id: string;
  league_id: string;
  user_id: string;
  ordered_player_ids: string[];
  submitted_at?: string;
  locked_at?: string;
  last_edited_by?: string;
  last_edited_at?: string;
  created_at: string;
  updated_at: string;
}

// ===== SCORING =====
export interface GameScore {
  id: string;
  player_id: string;
  season: number;
  round_stage: string;
  round_number: number;
  game_date: string;
  game_status: 'scheduled' | 'in_progress' | 'final';
  points: number;
  source: 'manual' | 'espn_api' | 'sportsradar_api';
  synced_at: string;
  created_at: string;
  updated_at: string;
}

export interface ScoringEvent {
  id: string;
  league_id: string;
  user_id: string;
  player_id: string;
  game_score_id: string;
  round_stage: string;
  points_credited: number;
  roster_slot_id?: string;
  is_stale: boolean;
  created_at: string;
  updated_at: string;
}

export interface LeaderboardSnapshot {
  id: string;
  league_id: string;
  user_id: string;
  total_points: number;
  active_player_count: number;
  highest_single_game_points: number;
  last_computed_at: string;
  round_stage: string;
  created_at: string;
  updated_at: string;
}

// ===== API REQUEST/RESPONSE TYPES =====

export interface CreateLeagueRequest {
  name: string;
  season: number;
  settings?: Partial<LeagueSettings>;
}

export interface CreateLeagueResponse {
  league: League;
  league_member: LeagueMember;
}

export interface SendInviteRequest {
  league_id: string;
  email: string;
}

export interface SendInviteResponse {
  invite: LeagueInvite;
  // Demo leagues: email suppressed with disclosure; invite_url contains the real link.
  email_stub?: boolean;
  invite_url?: string;
}

export interface GetInviteByTokenResponse {
  invite: LeagueInvite & {
    leagues: Pick<League, 'id' | 'name' | 'season'> | null;
    users: Pick<User, 'display_name'> | null;
  };
}

export interface AcceptInviteRequest {
  display_name?: string;
}

export interface AcceptInviteResponse {
  user: User;
  league_member: LeagueMember;
}

export interface AddToQueueRequest {
  draft_session_id: string;
  player_id: string;
  queue_position?: number;
}

export interface AddToQueueResponse {
  queue: DraftQueue[];
}

export interface GetPlayersQuery {
  position?: 'G' | 'F' | 'C';
  team_id?: string;
  search?: string;
  sort?: 'avg_ppg_desc' | 'team_seed' | 'name';
}

export interface GetPlayersResponse {
  players: Player[];
  total: number;
}

export interface GetTeamsResponse {
  teams: Pick<Team, 'id' | 'name' | 'seed' | 'region'>[];
}

export interface GetLeaguesResponse {
  leagues: League[];
}

export interface GetLeagueResponse {
  league: League;
  members: LeagueMember[];
  current_member: LeagueMember;
  draft_session_id: string | null;
  bench_lock_deadline: string | null;
  draft_status: 'scheduled' | 'live' | 'complete' | 'cancelled' | null;
  scheduled_start: string | null;
  season_in_progress: boolean;
  is_historical: boolean;
  has_roster_data: boolean;
}

export interface InviteListItem {
  id: string;
  invited_email: string;
  status: 'pending' | 'expired';
  sent_at: string;
  accepted_at: string | null;
  token: string;
  invite_url: string;
}

export interface GetInvitesResponse {
  invites: InviteListItem[];
}

export interface UpdateInviteStatusRequest {
  status: 'expired';
}

export interface UpdateInviteStatusResponse {
  invite: LeagueInvite;
}

export interface UpdateMemberRoleRequest {
  role: 'member' | 'co_commissioner';
}

export interface UpdateMemberRoleResponse {
  member: LeagueMember;
}
