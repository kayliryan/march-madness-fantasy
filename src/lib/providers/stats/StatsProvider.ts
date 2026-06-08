/**
 * StatsProvider Interface
 * Abstraction for fetching player stats, injury reports, game status, and team eliminations
 * Multiple implementations possible: ESPNStatsProvider, SportsRadarStatsProvider, etc.
 */

export interface PlayerStats {
  player_id: string;
  espn_player_id?: string;
  avg_ppg: number;
  games_played: number;
  total_points: number;
}

export interface InjuryReport {
  player_id: string;
  espn_player_id?: string;
  injury_status: 'active' | 'day_to_day' | 'out' | null;
  injury_note: string | null;
  updated_at: string;
}

export interface GameStatus {
  player_id: string;
  espn_player_id?: string;
  round_stage: string;
  round_number: number;
  game_date: string;
  game_status: 'scheduled' | 'in_progress' | 'final';
  points: number;
}

export interface TeamElimination {
  team_id: string;
  espn_team_id?: string;
  is_eliminated: boolean;
  eliminated_in_round_stage?: string;
  eliminated_in_round_number?: number;
}

export interface StatsProvider {
  /**
   * Get player statistics for a season
   */
  getPlayerStats(season: number): Promise<PlayerStats[]>;

  /**
   * Get current injury reports for all players
   */
  getInjuryReport(season: number): Promise<InjuryReport[]>;

  /**
   * Get game status and scores for a round
   */
  getGameStatus(season: number, round_stage: string): Promise<GameStatus[]>;

  /**
   * Get team elimination status
   */
  getTeamEliminations(season: number): Promise<TeamElimination[]>;
}
