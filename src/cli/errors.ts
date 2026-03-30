/**
 * CLI error types for structured exit code handling.
 *
 * Convention:
 *   - Exit 0: success
 *   - Exit 1: runtime error (operation failed, resource not found)
 *   - Exit 2: usage/validation error (bad flags, missing args)
 */

/** Thrown for usage/validation errors. Signals exit code 2. */
export class UsageError extends Error {
  readonly exitCode = 2;
  /** Optional hint shown below the error message (e.g., "Run 'grove init' to create one."). */
  readonly suggestion?: string | undefined;

  constructor(message: string, suggestion?: string) {
    super(message);
    this.name = "UsageError";
    this.suggestion = suggestion;
  }
}
