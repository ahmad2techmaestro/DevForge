export interface FuzzyMatch {
  score: number;
  /** Indices in the target string that matched the query, for highlighting. */
  indices: number[];
}

const SEPARATORS = new Set([' ', '/', '-', '_', '.', ':']);

/**
 * Subsequence fuzzy matcher. Rewards consecutive runs, matches at word starts and early matches.
 * Returns null when not every query character appears in order.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const t = target.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let ti = 0;
  let streak = 0;

  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    const atWordStart = found === 0 || SEPARATORS.has(t[found - 1]);
    streak = found === ti && indices.length > 0 ? streak + 1 : 0;
    score += 1 + streak * 2 + (atWordStart ? 3 : 0) - Math.min(found - ti, 6) * 0.15;
    indices.push(found);
    ti = found + 1;
  }
  if (t.startsWith(q)) score += 6;
  else if (t.includes(q)) score += 3;
  score -= t.length * 0.02;
  return { score, indices };
}

export interface Ranked<T> {
  item: T;
  match: FuzzyMatch;
}

export function rank<T>(items: T[], query: string, text: (item: T) => string, limit = 50): Ranked<T>[] {
  const out: Ranked<T>[] = [];
  for (const item of items) {
    const match = fuzzyMatch(query, text(item));
    if (match) out.push({ item, match });
  }
  if (query.trim()) out.sort((a, b) => b.match.score - a.match.score);
  return out.slice(0, limit);
}
