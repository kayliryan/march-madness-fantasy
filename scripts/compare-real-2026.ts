/**
 * One-off diagnostic: compare computed per-player totals (from real-2026-data.json)
 * against the user's final manual spreadsheet totals, to find the source of the
 * +524 point systematic overcount.
 *
 * Usage: npx tsx scripts/compare-real-2026.ts
 */

import { ROSTER } from './data/real-2026-roster';
import realData from './data/real-2026-data.json';

// Transcribed from the user's FINAL spreadsheet (sum of all Round1-6 cells per player)
const SPREADSHEET_TOTALS: Record<string, number> = {
  'Spoza|F1': 90, // Cameron Boozer
  'Spoza|G1': 73, // Labaron Philon Jr.
  'Spoza|C1': 30, // Chris Cenac Jr.
  'Spoza|F2': 23, // Boogie Fland
  'Spoza|G2': 47, // Tamin Lipsey
  'Spoza|B1': 12, // Tobe Awaka
  'Spoza|B2': 30, // Trey Kaufman-Renn
  'Spoza|B3': 36, // Braylon Mullins

  'Baby Luv|F1': 65, // Isaiah Evans
  'Baby Luv|C1': 51, // Motiejus Krivas
  'Baby Luv|F2': 0, // Alex Condon
  'Baby Luv|G1': 72, // Trey McKenney
  'Baby Luv|G2': 64, // Fletcher Loyer
  'Baby Luv|B1': 97, // Alex Karaban
  'Baby Luv|B2': 0, // Tyon Grant-Foster
  'Baby Luv|B3': 0, // Johann Grunloh

  'Bub|G1': 66, // Brayden Burries
  'Bub|F1': 43, // Milan Momcilovic
  'Bub|C1': 117, // Tarris Reed Jr.
  'Bub|F2': 35, // A.J. Dybantsa
  'Bub|G2': 27, // Nick Boyd
  'Bub|B1': 31, // Cayden Boozer
  'Bub|B2': 22, // John Blackwell
  'Bub|B3': 69, // Elliot Cadeau

  'Sienna|G1': 88, // Darius Acuff Jr.
  'Sienna|C1': 14, // Rueben Chinyelu
  'Sienna|F1': 25, // Nate Ament
  'Sienna|F2': 63, // Pryce Sandfort
  'Sienna|G2': 13, // Jeremy Fears Jr.
  'Sienna|B1': 40, // Malik Reneau
  'Sienna|B2': 0, // Flory Bidunga
  'Sienna|B3': 32, // Nimari Burnett

  'Bit T Bee|F1': 33, // Thomas Haugh
  'Bit T Bee|F2': 74, // Yaxel Lendeborg
  'Bit T Bee|G1': 53, // Solo Ball
  'Bit T Bee|G2': 49, // Darryn Peterson
  'Bit T Bee|C1': 26, // Henri Veesaar
  'Bit T Bee|B1': 32, // Thijs De Ridder
  'Bit T Bee|B2': 29, // Braden Smith
  'Bit T Bee|B3': 23, // Carson Cooper

  'Pooka|G1': 66, // Jaden Bradley
  'Pooka|G2': 51, // Emanuel Sharp
  'Pooka|F1': 44, // Graham Ike
  'Pooka|F2': 57, // Koa Peat
  'Pooka|C1': 88, // Aday Mara
  'Pooka|B1': 49, // Zuby Ejiofor
  'Pooka|B2': 45, // Keaton Wagler
  'Pooka|B3': 0, // Urban Klavzar

  'The Dad|G1': 38, // Kingston Flemings
  'The Dad|C1': 6, // Patrick Ngongba II
  'The Dad|F1': 62, // Ivan Kharchenkov
  'The Dad|F2': 77, // Morez Johnson Jr.
  'The Dad|G2': 0, // Xaivian Lee
  'The Dad|B1': 25, // Christian Anderson
  'The Dad|B2': 6, // Milos Uzan
  'The Dad|B3': 44, // Oscar Cluff
};

interface GameScoreEntry {
  member: string;
  slot_key: string;
  round_stage: string;
  game_date: string;
  points: number;
}

const gameScores = realData.game_scores as GameScoreEntry[];

let totalSheet = 0;
let totalComputed = 0;
let totalDiff = 0;

for (const r of ROSTER) {
  const key = `${r.member}|${r.slot_key}`;
  const rows = gameScores.filter((g) => g.member === r.member && g.slot_key === r.slot_key);
  const computed = rows.reduce((sum, g) => sum + g.points, 0);
  const sheet = SPREADSHEET_TOTALS[key] ?? 0;
  const diff = computed - sheet;
  totalSheet += sheet;
  totalComputed += computed;
  totalDiff += diff;

  if (diff !== 0) {
    const breakdown = rows.map((g) => `${g.round_stage}:${g.points}`).join(', ');
    console.log(`${key.padEnd(20)} ${r.player.padEnd(22)} sheet=${String(sheet).padStart(3)} computed=${String(computed).padStart(3)} diff=${diff > 0 ? '+' : ''}${diff}  [${breakdown}]`);
  }
}

console.log('\n--- Totals ---');
console.log(`sheet total:    ${totalSheet}`);
console.log(`computed total: ${totalComputed}`);
console.log(`diff:           ${totalDiff}`);
