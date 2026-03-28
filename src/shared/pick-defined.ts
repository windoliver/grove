/**
 * Pick only the defined (non-undefined) keys from an object.
 *
 * Replaces the verbose pattern:
 *   ...(input.x !== undefined ? { x: input.x } : {}),
 *   ...(input.y !== undefined ? { y: input.y } : {}),
 */
export function pickDefined<T, K extends keyof T>(obj: T, keys: readonly K[]): { [P in K]?: T[P] } {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (obj[key] !== undefined) {
      result[key as string] = obj[key];
    }
  }
  return result as { [P in K]?: T[P] };
}
