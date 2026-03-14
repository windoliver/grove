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

  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
