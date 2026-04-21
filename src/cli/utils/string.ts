/**
 * String utilities for the CLI.
 */

/**
 * Compute the Levenshtein edit distance between two strings.
 * Used for typo suggestions when an unknown command is entered.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Keep only two rows to avoid O(n*m) matrix allocation.
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] as number) + 1, // deletion
        (current[j - 1] as number) + 1, // insertion
        (previous[j - 1] as number) + cost, // substitution
      );
    }
    [previous, current] = [current, previous];
  }

  return (previous[b.length] as number) ?? 0;
}

function boundedLevenshteinDistance(a: string, b: string, maxDistance: number): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  const sentinel = maxDistance + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  let current = new Array<number>(b.length + 1).fill(sentinel);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    const jStart = Math.max(1, i - maxDistance);
    const jEnd = Math.min(b.length, i + maxDistance);
    let rowMin = sentinel;

    for (let j = 1; j < jStart; j++) current[j] = sentinel;

    for (let j = jStart; j <= jEnd; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }

    for (let j = jEnd + 1; j <= b.length; j++) current[j] = sentinel;

    if (rowMin > maxDistance) return sentinel;
    [previous, current] = [current, previous];
  }

  return previous[b.length] as number;
}

/**
 * Find the closest command name to a given input.
 * Returns the suggestion if edit distance <= maxDistance, otherwise undefined.
 */
export function suggestCommand(
  input: string,
  commandNames: readonly string[],
  maxDistance = 3,
): string | undefined {
  if (maxDistance < 0) return undefined;

  let best: string | undefined;
  let bestDist = maxDistance + 1;

  for (const name of commandNames) {
    if (Math.abs(input.length - name.length) > maxDistance) continue;
    const dist = boundedLevenshteinDistance(input, name, bestDist - 1);
    if (dist < bestDist) {
      bestDist = dist;
      best = name;
      if (bestDist === 0) break;
    }
  }

  return best;
}
