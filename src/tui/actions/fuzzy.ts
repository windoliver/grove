/**
 * Pure fuzzy-matching primitive shared by the palette renderer and the action
 * visibility/ranking helper. Lives in its own module so neither
 * `command-palette.tsx` nor `visibility.ts` has to import the other (avoids a
 * circular dependency).
 */

/** Result of a fuzzy match attempt. */
export interface FuzzyResult {
  readonly match: boolean;
  readonly score: number;
  /** Indices in `text` that matched pattern characters. */
  readonly matchedIndices: readonly number[];
}

/**
 * Fuzzy-match `pattern` against `text`.
 *
 * Scoring: +2 for a match at position 0 or after a space / '/', +1 otherwise.
 */
export function fuzzyMatch(pattern: string, text: string): FuzzyResult {
  if (!pattern) return { match: true, score: 0, matchedIndices: [] };
  const lower = text.toLowerCase();
  const pat = pattern.toLowerCase();
  let pi = 0;
  let score = 0;
  const matchedIndices: number[] = [];
  for (let i = 0; i < lower.length && pi < pat.length; i++) {
    if (lower[i] === pat[pi]) {
      const bonus = i === 0 || lower[i - 1] === " " || lower[i - 1] === "/" ? 2 : 1;
      score += bonus;
      matchedIndices.push(i);
      pi++;
    }
  }
  return { match: pi === pat.length, score, matchedIndices };
}
