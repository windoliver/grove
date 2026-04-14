/** Shared shell utility functions for runtime implementations. */

/** Escape a string for safe use in shell commands (single-quote wrapping). */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
