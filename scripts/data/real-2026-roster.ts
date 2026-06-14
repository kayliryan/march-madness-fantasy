/**
 * Source data for the "real 2026 tournament" validation league.
 *
 * Roster data transcribed from the user's family league spreadsheet (7 members,
 * 8 players each: 2G/2F/1C starters + 3 bench). Team/elimination/game data derived
 * from ESPN's public scoreboard API for date range 20260317-20260410, groups=50
 * (NCAA tournament games only).
 *
 * round_stage numbering: r64=1, r32=2, s16=3, e8=4, f4=5, championship=6.
 */

export type RoundStage = 'r64' | 'r32' | 's16' | 'e8' | 'f4' | 'championship';

export interface TeamInfo {
  key: string;
  espn_id: string;
  name: string;
  seed: number;
  region: string;
  eliminated_in_round_stage: RoundStage | null;
  eliminated_in_round_number: number | null;
  is_eliminated: boolean;
}

export const TEAMS: TeamInfo[] = [
  { key: 'duke', espn_id: '150', name: 'Duke', seed: 1, region: 'East', eliminated_in_round_stage: 'e8', eliminated_in_round_number: 4, is_eliminated: true },
  { key: 'alabama', espn_id: '333', name: 'Alabama', seed: 4, region: 'Midwest', eliminated_in_round_stage: 's16', eliminated_in_round_number: 3, is_eliminated: true },
  { key: 'houston', espn_id: '248', name: 'Houston', seed: 2, region: 'South', eliminated_in_round_stage: 's16', eliminated_in_round_number: 3, is_eliminated: true },
  { key: 'florida', espn_id: '57', name: 'Florida', seed: 1, region: 'South', eliminated_in_round_stage: 'r32', eliminated_in_round_number: 2, is_eliminated: true },
  { key: 'iowa_state', espn_id: '66', name: 'Iowa State', seed: 2, region: 'Midwest', eliminated_in_round_stage: 's16', eliminated_in_round_number: 3, is_eliminated: true },
  { key: 'arizona', espn_id: '12', name: 'Arizona', seed: 1, region: 'West', eliminated_in_round_stage: 'f4', eliminated_in_round_number: 5, is_eliminated: true },
  { key: 'purdue', espn_id: '2509', name: 'Purdue', seed: 2, region: 'West', eliminated_in_round_stage: 'e8', eliminated_in_round_number: 4, is_eliminated: true },
  { key: 'uconn', espn_id: '41', name: 'UConn', seed: 2, region: 'East', eliminated_in_round_stage: 'championship', eliminated_in_round_number: 6, is_eliminated: true },
  { key: 'michigan', espn_id: '130', name: 'Michigan', seed: 1, region: 'Midwest', eliminated_in_round_stage: null, eliminated_in_round_number: null, is_eliminated: false },
  { key: 'gonzaga', espn_id: '2250', name: 'Gonzaga', seed: 3, region: 'West', eliminated_in_round_stage: 'r32', eliminated_in_round_number: 2, is_eliminated: true },
  { key: 'virginia', espn_id: '258', name: 'Virginia', seed: 3, region: 'Midwest', eliminated_in_round_stage: 'r32', eliminated_in_round_number: 2, is_eliminated: true },
  { key: 'byu', espn_id: '252', name: 'BYU', seed: 6, region: 'West', eliminated_in_round_stage: 'r64', eliminated_in_round_number: 1, is_eliminated: true },
  { key: 'wisconsin', espn_id: '275', name: 'Wisconsin', seed: 5, region: 'West', eliminated_in_round_stage: 'r64', eliminated_in_round_number: 1, is_eliminated: true },
  { key: 'arkansas', espn_id: '8', name: 'Arkansas', seed: 4, region: 'West', eliminated_in_round_stage: 's16', eliminated_in_round_number: 3, is_eliminated: true },
  { key: 'tennessee', espn_id: '2633', name: 'Tennessee', seed: 6, region: 'Midwest', eliminated_in_round_stage: 'e8', eliminated_in_round_number: 4, is_eliminated: true },
  { key: 'nebraska', espn_id: '158', name: 'Nebraska', seed: 4, region: 'South', eliminated_in_round_stage: 's16', eliminated_in_round_number: 3, is_eliminated: true },
  { key: 'michigan_state', espn_id: '127', name: 'Michigan State', seed: 3, region: 'East', eliminated_in_round_stage: 's16', eliminated_in_round_number: 3, is_eliminated: true },
  { key: 'miami', espn_id: '2390', name: 'Miami', seed: 7, region: 'West', eliminated_in_round_stage: 'r32', eliminated_in_round_number: 2, is_eliminated: true },
  { key: 'kansas', espn_id: '2305', name: 'Kansas', seed: 4, region: 'East', eliminated_in_round_stage: 'r32', eliminated_in_round_number: 2, is_eliminated: true },
  { key: 'north_carolina', espn_id: '153', name: 'North Carolina', seed: 6, region: 'South', eliminated_in_round_stage: 'r64', eliminated_in_round_number: 1, is_eliminated: true },
  { key: 'st_johns', espn_id: '2599', name: "St. John's", seed: 5, region: 'East', eliminated_in_round_stage: 's16', eliminated_in_round_number: 3, is_eliminated: true },
  { key: 'illinois', espn_id: '356', name: 'Illinois', seed: 3, region: 'South', eliminated_in_round_stage: 'f4', eliminated_in_round_number: 5, is_eliminated: true },
  { key: 'texas_tech', espn_id: '2641', name: 'Texas Tech', seed: 5, region: 'Midwest', eliminated_in_round_stage: 'r32', eliminated_in_round_number: 2, is_eliminated: true },
];

export interface RosterEntry {
  member: string;
  slot_key: string; // G1, G2, F1, F2, C1 (starters) or B1-B3 (bench)
  slot_position: 'G' | 'F' | 'C';
  is_bench: boolean;
  team: string; // TeamInfo.key
  player: string;
  avg_ppg: number;
}

export const ROSTER: RosterEntry[] = [
  // Spoza
  { member: 'Spoza', slot_key: 'F1', slot_position: 'F', is_bench: false, team: 'duke', player: 'Cameron Boozer', avg_ppg: 23 },
  { member: 'Spoza', slot_key: 'G1', slot_position: 'G', is_bench: false, team: 'alabama', player: 'Labaron Philon Jr.', avg_ppg: 21.3 },
  { member: 'Spoza', slot_key: 'C1', slot_position: 'C', is_bench: false, team: 'houston', player: 'Chris Cenac Jr.', avg_ppg: 9.8 },
  { member: 'Spoza', slot_key: 'F2', slot_position: 'F', is_bench: false, team: 'florida', player: 'Boogie Fland', avg_ppg: 11.6 },
  { member: 'Spoza', slot_key: 'G2', slot_position: 'G', is_bench: false, team: 'iowa_state', player: 'Tamin Lipsey', avg_ppg: 13.2 },
  { member: 'Spoza', slot_key: 'B1', slot_position: 'F', is_bench: true, team: 'arizona', player: 'Tobe Awaka', avg_ppg: 9.6 },
  { member: 'Spoza', slot_key: 'B2', slot_position: 'F', is_bench: true, team: 'purdue', player: 'Trey Kaufman-Renn', avg_ppg: 12.4 },
  { member: 'Spoza', slot_key: 'B3', slot_position: 'G', is_bench: true, team: 'uconn', player: 'Braylon Mullins', avg_ppg: 10.5 },

  // Baby Luv
  { member: 'Baby Luv', slot_key: 'F1', slot_position: 'F', is_bench: false, team: 'duke', player: 'Isaiah Evans', avg_ppg: 13.4 },
  { member: 'Baby Luv', slot_key: 'C1', slot_position: 'C', is_bench: false, team: 'arizona', player: 'Motiejus Krivas', avg_ppg: 11.1 },
  { member: 'Baby Luv', slot_key: 'F2', slot_position: 'F', is_bench: false, team: 'florida', player: 'Alex Condon', avg_ppg: 13.4 },
  { member: 'Baby Luv', slot_key: 'G1', slot_position: 'G', is_bench: false, team: 'michigan', player: 'Trey McKenney', avg_ppg: 10.4 },
  { member: 'Baby Luv', slot_key: 'G2', slot_position: 'G', is_bench: false, team: 'purdue', player: 'Fletcher Loyer', avg_ppg: 13.5 },
  { member: 'Baby Luv', slot_key: 'B1', slot_position: 'F', is_bench: true, team: 'uconn', player: 'Alex Karaban', avg_ppg: 11.5 },
  { member: 'Baby Luv', slot_key: 'B2', slot_position: 'G', is_bench: true, team: 'gonzaga', player: 'Tyon Grant-Foster', avg_ppg: 11.2 },
  { member: 'Baby Luv', slot_key: 'B3', slot_position: 'C', is_bench: true, team: 'virginia', player: 'Johann Grunloh', avg_ppg: 7.7 },

  // Bub
  { member: 'Bub', slot_key: 'G1', slot_position: 'G', is_bench: false, team: 'arizona', player: 'Brayden Burries', avg_ppg: 15.7 },
  { member: 'Bub', slot_key: 'F1', slot_position: 'F', is_bench: false, team: 'iowa_state', player: 'Milan Momcilovic', avg_ppg: 17 },
  { member: 'Bub', slot_key: 'C1', slot_position: 'C', is_bench: false, team: 'uconn', player: 'Tarris Reed Jr.', avg_ppg: 13.8 },
  { member: 'Bub', slot_key: 'F2', slot_position: 'F', is_bench: false, team: 'byu', player: 'A.J. Dybantsa', avg_ppg: 24.8 },
  { member: 'Bub', slot_key: 'G2', slot_position: 'G', is_bench: false, team: 'wisconsin', player: 'Nick Boyd', avg_ppg: 20.3 },
  { member: 'Bub', slot_key: 'B1', slot_position: 'G', is_bench: true, team: 'duke', player: 'Cayden Boozer', avg_ppg: 6.8 },
  { member: 'Bub', slot_key: 'B2', slot_position: 'G', is_bench: true, team: 'wisconsin', player: 'John Blackwell', avg_ppg: 18.5 },
  { member: 'Bub', slot_key: 'B3', slot_position: 'G', is_bench: true, team: 'michigan', player: 'Elliot Cadeau', avg_ppg: 9.6 },

  // Sienna
  { member: 'Sienna', slot_key: 'G1', slot_position: 'G', is_bench: false, team: 'arkansas', player: 'Darius Acuff Jr.', avg_ppg: 22.2 },
  { member: 'Sienna', slot_key: 'C1', slot_position: 'C', is_bench: false, team: 'florida', player: 'Rueben Chinyelu', avg_ppg: 11.2 },
  { member: 'Sienna', slot_key: 'F1', slot_position: 'F', is_bench: false, team: 'tennessee', player: 'Nate Ament', avg_ppg: 16 },
  { member: 'Sienna', slot_key: 'F2', slot_position: 'F', is_bench: false, team: 'nebraska', player: 'Pryce Sandfort', avg_ppg: 19.9 },
  { member: 'Sienna', slot_key: 'G2', slot_position: 'G', is_bench: false, team: 'michigan_state', player: 'Jeremy Fears Jr.', avg_ppg: 15.5 },
  { member: 'Sienna', slot_key: 'B1', slot_position: 'F', is_bench: true, team: 'miami', player: 'Malik Reneau', avg_ppg: 20.2 },
  { member: 'Sienna', slot_key: 'B2', slot_position: 'F', is_bench: true, team: 'kansas', player: 'Flory Bidunga', avg_ppg: 14.2 },
  { member: 'Sienna', slot_key: 'B3', slot_position: 'G', is_bench: true, team: 'michigan', player: 'Nimari Burnett', avg_ppg: 8.5 },

  // Bit T Bee
  { member: 'Bit T Bee', slot_key: 'F1', slot_position: 'F', is_bench: false, team: 'florida', player: 'Thomas Haugh', avg_ppg: 17.2 },
  { member: 'Bit T Bee', slot_key: 'F2', slot_position: 'F', is_bench: false, team: 'michigan', player: 'Yaxel Lendeborg', avg_ppg: 14.7 },
  { member: 'Bit T Bee', slot_key: 'G1', slot_position: 'G', is_bench: false, team: 'uconn', player: 'Solo Ball', avg_ppg: 13.9 },
  { member: 'Bit T Bee', slot_key: 'G2', slot_position: 'G', is_bench: false, team: 'kansas', player: 'Darryn Peterson', avg_ppg: 19.5 },
  { member: 'Bit T Bee', slot_key: 'C1', slot_position: 'C', is_bench: false, team: 'north_carolina', player: 'Henri Veesaar', avg_ppg: 16.4 },
  { member: 'Bit T Bee', slot_key: 'B1', slot_position: 'F', is_bench: true, team: 'virginia', player: 'Thijs De Ridder', avg_ppg: 15.9 },
  { member: 'Bit T Bee', slot_key: 'B2', slot_position: 'G', is_bench: true, team: 'purdue', player: 'Braden Smith', avg_ppg: 14.7 },
  { member: 'Bit T Bee', slot_key: 'B3', slot_position: 'C', is_bench: true, team: 'michigan_state', player: 'Carson Cooper', avg_ppg: 10.7 },

  // Pooka
  { member: 'Pooka', slot_key: 'G1', slot_position: 'G', is_bench: false, team: 'arizona', player: 'Jaden Bradley', avg_ppg: 13.4 },
  { member: 'Pooka', slot_key: 'G2', slot_position: 'G', is_bench: false, team: 'houston', player: 'Emanuel Sharp', avg_ppg: 15.8 },
  { member: 'Pooka', slot_key: 'F1', slot_position: 'F', is_bench: false, team: 'gonzaga', player: 'Graham Ike', avg_ppg: 19.7 },
  { member: 'Pooka', slot_key: 'F2', slot_position: 'F', is_bench: false, team: 'arizona', player: 'Koa Peat', avg_ppg: 14 },
  { member: 'Pooka', slot_key: 'C1', slot_position: 'C', is_bench: false, team: 'michigan', player: 'Aday Mara', avg_ppg: 11.3 },
  { member: 'Pooka', slot_key: 'B1', slot_position: 'F', is_bench: true, team: 'st_johns', player: 'Zuby Ejiofor', avg_ppg: 15.7 },
  { member: 'Pooka', slot_key: 'B2', slot_position: 'G', is_bench: true, team: 'illinois', player: 'Keaton Wagler', avg_ppg: 17.9 },
  { member: 'Pooka', slot_key: 'B3', slot_position: 'G', is_bench: true, team: 'florida', player: 'Urban Klavzar', avg_ppg: 9.7 },

  // The Dad
  { member: 'The Dad', slot_key: 'G1', slot_position: 'G', is_bench: false, team: 'houston', player: 'Kingston Flemings', avg_ppg: 16.5 },
  { member: 'The Dad', slot_key: 'C1', slot_position: 'C', is_bench: false, team: 'duke', player: 'Patrick Ngongba II', avg_ppg: 11 },
  { member: 'The Dad', slot_key: 'F1', slot_position: 'F', is_bench: false, team: 'arizona', player: 'Ivan Kharchenkov', avg_ppg: 9.7 },
  { member: 'The Dad', slot_key: 'F2', slot_position: 'F', is_bench: false, team: 'michigan', player: 'Morez Johnson Jr.', avg_ppg: 12.5 },
  { member: 'The Dad', slot_key: 'G2', slot_position: 'G', is_bench: false, team: 'florida', player: 'Xaivian Lee', avg_ppg: 11.5 },
  { member: 'The Dad', slot_key: 'B1', slot_position: 'G', is_bench: true, team: 'texas_tech', player: 'Christian Anderson', avg_ppg: 19.1 },
  { member: 'The Dad', slot_key: 'B2', slot_position: 'G', is_bench: true, team: 'houston', player: 'Milos Uzan', avg_ppg: 11.3 },
  { member: 'The Dad', slot_key: 'B3', slot_position: 'C', is_bench: true, team: 'purdue', player: 'Oscar Cluff', avg_ppg: 10.5 },
];

export interface GameInfo {
  event_id: string;
  round_stage: RoundStage;
  date: string; // YYYY-MM-DD
  teams: string[]; // TeamInfo.key values present in this game (1 or 2 of "ours")
}

export const GAMES: GameInfo[] = [
  // r64
  { event_id: '401856478', round_stage: 'r64', date: '2026-03-19', teams: ['duke'] },
  { event_id: '401856486', round_stage: 'r64', date: '2026-03-19', teams: ['michigan'] },
  { event_id: '401856493', round_stage: 'r64', date: '2026-03-20', teams: ['houston'] },
  { event_id: '401856483', round_stage: 'r64', date: '2026-03-19', teams: ['michigan_state'] },
  { event_id: '401856491', round_stage: 'r64', date: '2026-03-20', teams: ['illinois'] },
  { event_id: '401856485', round_stage: 'r64', date: '2026-03-20', teams: ['gonzaga'] },
  { event_id: '401856489', round_stage: 'r64', date: '2026-03-19', teams: ['nebraska'] },
  { event_id: '401856481', round_stage: 'r64', date: '2026-03-19', teams: ['arkansas'] },
  { event_id: '401856480', round_stage: 'r64', date: '2026-03-19', teams: ['wisconsin'] },
  { event_id: '401856490', round_stage: 'r64', date: '2026-03-19', teams: ['north_carolina'] },
  { event_id: '401856484', round_stage: 'r64', date: '2026-03-19', teams: ['byu'] },
  { event_id: '401856529', round_stage: 'r64', date: '2026-03-20', teams: ['arizona'] },
  { event_id: '401856523', round_stage: 'r64', date: '2026-03-21', teams: ['florida'] },
  { event_id: '401856524', round_stage: 'r64', date: '2026-03-20', teams: ['iowa_state'] },
  { event_id: '401856519', round_stage: 'r64', date: '2026-03-20', teams: ['purdue'] },
  { event_id: '401856497', round_stage: 'r64', date: '2026-03-21', teams: ['uconn'] },
  { event_id: '401856526', round_stage: 'r64', date: '2026-03-20', teams: ['virginia'] },
  { event_id: '401856521', round_stage: 'r64', date: '2026-03-20', teams: ['alabama'] },
  { event_id: '401856495', round_stage: 'r64', date: '2026-03-21', teams: ['kansas'] },
  { event_id: '401856520', round_stage: 'r64', date: '2026-03-20', teams: ['texas_tech'] },
  { event_id: '401856494', round_stage: 'r64', date: '2026-03-20', teams: ['st_johns'] },
  { event_id: '401856527', round_stage: 'r64', date: '2026-03-20', teams: ['tennessee'] },
  { event_id: '401856518', round_stage: 'r64', date: '2026-03-21', teams: ['miami'] },

  // r32
  { event_id: '401856532', round_stage: 'r32', date: '2026-03-21', teams: ['michigan'] },
  { event_id: '401856530', round_stage: 'r32', date: '2026-03-21', teams: ['duke'] },
  { event_id: '401856535', round_stage: 'r32', date: '2026-03-21', teams: ['houston'] },
  { event_id: '401856531', round_stage: 'r32', date: '2026-03-21', teams: ['michigan_state'] },
  { event_id: '401856537', round_stage: 'r32', date: '2026-03-21', teams: ['gonzaga'] },
  { event_id: '401856533', round_stage: 'r32', date: '2026-03-22', teams: ['illinois'] },
  { event_id: '401856534', round_stage: 'r32', date: '2026-03-22', teams: ['nebraska'] },
  { event_id: '401856536', round_stage: 'r32', date: '2026-03-22', teams: ['arkansas'] },
  { event_id: '401856563', round_stage: 'r32', date: '2026-03-22', teams: ['florida'] },
  { event_id: '401856565', round_stage: 'r32', date: '2026-03-23', teams: ['arizona'] },
  { event_id: '401856564', round_stage: 'r32', date: '2026-03-22', teams: ['purdue', 'miami'] },
  { event_id: '401856561', round_stage: 'r32', date: '2026-03-22', teams: ['iowa_state'] },
  { event_id: '401856559', round_stage: 'r32', date: '2026-03-23', teams: ['uconn'] },
  { event_id: '401856562', round_stage: 'r32', date: '2026-03-22', teams: ['virginia', 'tennessee'] },
  { event_id: '401856558', round_stage: 'r32', date: '2026-03-22', teams: ['kansas', 'st_johns'] },
  { event_id: '401856560', round_stage: 'r32', date: '2026-03-23', teams: ['alabama', 'texas_tech'] },

  // s16
  { event_id: '401856569', round_stage: 's16', date: '2026-03-27', teams: ['arizona', 'arkansas'] },
  { event_id: '401856568', round_stage: 's16', date: '2026-03-26', teams: ['purdue'] },
  { event_id: '401856566', round_stage: 's16', date: '2026-03-27', teams: ['houston', 'illinois'] },
  { event_id: '401856567', round_stage: 's16', date: '2026-03-26', teams: ['nebraska'] },
  { event_id: '401856570', round_stage: 's16', date: '2026-03-27', teams: ['duke', 'st_johns'] },
  { event_id: '401856572', round_stage: 's16', date: '2026-03-27', teams: ['michigan', 'alabama'] },
  { event_id: '401856571', round_stage: 's16', date: '2026-03-28', teams: ['uconn', 'michigan_state'] },
  { event_id: '401856573', round_stage: 's16', date: '2026-03-28', teams: ['iowa_state', 'tennessee'] },

  // e8
  { event_id: '401856575', round_stage: 'e8', date: '2026-03-29', teams: ['arizona', 'purdue'] },
  { event_id: '401856574', round_stage: 'e8', date: '2026-03-28', teams: ['illinois'] },
  { event_id: '401856576', round_stage: 'e8', date: '2026-03-29', teams: ['michigan', 'tennessee'] },
  { event_id: '401856577', round_stage: 'e8', date: '2026-03-29', teams: ['duke', 'uconn'] },

  // f4
  { event_id: '401856599', round_stage: 'f4', date: '2026-04-05', teams: ['arizona', 'michigan'] },
  { event_id: '401856598', round_stage: 'f4', date: '2026-04-04', teams: ['uconn', 'illinois'] },

  // championship
  { event_id: '401856600', round_stage: 'championship', date: '2026-04-07', teams: ['michigan', 'uconn'] },
];
