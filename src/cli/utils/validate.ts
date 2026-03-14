/**
 * Lightweight validation error collection utility.
 *
 * Collects multiple validation errors and formats them together,
 * so users see all problems at once instead of fixing one at a time.
 */

/** A single validation error with the flag/field that failed. */
export interface ValidationError {
  readonly field: string;
  readonly message: string;
}

/**
 * Collect validation errors from a list of checks.
 *
 * Each check is a tuple of [condition, error]. If condition is true,
 * the error is collected. Returns the collected errors.
 *
 * @example
 * ```ts
 * const errors = collectErrors([
 *   [!title, { field: "title", message: "title is required" }],
 *   [!amount, { field: "--amount", message: "--amount is required" }],
 * ]);
 * ```
 */
export function collectErrors(
  checks: readonly (readonly [boolean, ValidationError])[],
): readonly ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [failed, error] of checks) {
    if (failed) {
      errors.push(error);
    }
  }
  return errors;
}

/**
 * Format collected validation errors for CLI display.
 *
 * Returns null if no errors, or a formatted string like:
 *   Error: 2 validation errors:
 *     • --amount is required
 *     • --deadline is required
 */
export function formatValidationErrors(
  errors: readonly ValidationError[],
  hint?: string,
): string | null {
  if (errors.length === 0) return null;

  if (errors.length === 1) {
    const line = `Error: ${errors[0]?.message}`;
    return hint ? `${line}\n\n${hint}` : line;
  }

  const header = `Error: ${errors.length} validation errors:`;
  const items = errors.map((e) => `  \u2022 ${e.message}`).join("\n");
  const body = `${header}\n${items}`;
  return hint ? `${body}\n\n${hint}` : body;
}
