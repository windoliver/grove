/**
 * String utilities for the CLI.
 */

/**
 * Compute the Levenshtein edit distance between two strings.
 * Used for typo suggestions when an unknown command is entered.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1, // deletion
        matrix[i]![j - 1]! + 1, // insertion
        matrix[i - 1]![j - 1]! + cost, // substitution
      );
    }
  }

  return matrix[b.length]![a.length]!;
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
  let best: string | undefined;
  let bestDist = maxDistance + 1;

  for (const name of commandNames) {
    const dist = levenshteinDistance(input, name);
    if (dist < bestDist) {
      bestDist = dist;
      best = name;
    }
  }

  return best;
}
