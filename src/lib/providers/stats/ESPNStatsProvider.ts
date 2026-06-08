import {
  StatsProvider,
  PlayerStats,
  InjuryReport,
  GameStatus,
  TeamElimination,
} from './StatsProvider';
import teamsData from '@/mocks/fixtures/espn/teams-2026.json';
import playersData from '@/mocks/fixtures/espn/players-2026.json';

/**
 * ESPNStatsProvider
 * Fetches stats from ESPN Unofficial API (or mock data if MOCK_ESPN=true)
 */
export class ESPNStatsProvider implements StatsProvider {
  private isMocked: boolean;

  constructor() {
    this.isMocked = process.env.MOCK_ESPN === 'true';
  }

  async getPlayerStats(season: number): Promise<PlayerStats[]> {
    if (this.isMocked) {
      return this.getMockPlayerStats(season);
    }

    // Real ESPN API call would go here
    // For now, fall back to mock
    return this.getMockPlayerStats(season);
  }

  async getInjuryReport(season: number): Promise<InjuryReport[]> {
    if (this.isMocked) {
      return this.getMockInjuryReport(season);
    }

    // Real ESPN API call would go here
    return this.getMockInjuryReport(season);
  }

  async getGameStatus(season: number, round_stage: string): Promise<GameStatus[]> {
    if (this.isMocked) {
      return this.getMockGameStatus(season, round_stage);
    }

    // Real ESPN API call would go here
    return this.getMockGameStatus(season, round_stage);
  }

  async getTeamEliminations(season: number): Promise<TeamElimination[]> {
    if (this.isMocked) {
      return this.getMockTeamEliminations(season);
    }

    // Real ESPN API call would go here
    return this.getMockTeamEliminations(season);
  }

  // Mock implementations
  private getMockPlayerStats(season: number): PlayerStats[] {
    return playersData.map((player, index) => ({
      player_id: `mock-player-${index}`,
      espn_player_id: `espn-${index}`,
      avg_ppg: player.avg_ppg,
      games_played: 32,
      total_points: Math.round(player.avg_ppg * 32),
    }));
  }

  private getMockInjuryReport(season: number): InjuryReport[] {
    // Randomly assign some players as day_to_day
    return playersData.map((player, index) => {
      const rand = Math.random();
      let status: 'active' | 'day_to_day' | 'out' | null = 'active';
      let note: string | null = null;

      if (rand > 0.95) {
        status = 'out';
        note = 'Torn ACL';
      } else if (rand > 0.88) {
        status = 'day_to_day';
        note = 'Ankle soreness';
      }

      return {
        player_id: `mock-player-${index}`,
        espn_player_id: `espn-${index}`,
        injury_status: status,
        injury_note: note,
        updated_at: new Date().toISOString(),
      };
    });
  }

  private getMockGameStatus(season: number, round_stage: string): GameStatus[] {
    // Return empty for now - games haven't been played yet in the draft phase
    return [];
  }

  private getMockTeamEliminations(season: number): TeamElimination[] {
    // All teams active at the start
    return teamsData.map((team) => ({
      team_id: `mock-team-${team.name}`,
      espn_team_id: `espn-${team.name}`,
      is_eliminated: false,
    }));
  }
}

// Export singleton instance
export const espnStatsProvider = new ESPNStatsProvider();
