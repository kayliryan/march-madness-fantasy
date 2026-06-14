/**
 * Fisher-Yates shuffle — uniformly random.
 * Do NOT use Array.sort(() => Math.random() - 0.5) — not uniformly random.
 */
export function fisherYatesShuffle<T>(array: T[]): T[] {
  const arr = [...array]; // copy — does not mutate input
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
