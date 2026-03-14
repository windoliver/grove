/**
 * Safe cleanup utility for fire-and-forget error handling.
 *
 * Replaces the `.catch(() => {})` anti-pattern with explicit,
 * logged error handling. Expected cleanup failures (e.g., deleting
 * already-deleted resources) are silently absorbed. Unexpected
 * failures are logged with context for debugging.
 */

/**
 * Absorb errors from a cleanup/rollback promise, logging unexpected failures.
 *
 * Use this instead of `.catch(() => {})` to ensure errors are visible
 * when they matter while still allowing cleanup operations to fail
 * gracefully.
 *
 * @param promise - The cleanup operation that may fail.
 * @param context - A short description of what the cleanup does (for log messages).
 * @param options.silent - If true, suppresses all logging (for truly expected failures).
 */
export function safeCleanup(
  promise: Promise<unknown>,
  context: string,
  options?: { readonly silent?: boolean | undefined },
): Promise<void> {
  return promise.then(
    () => undefined,
    (err: unknown) => {
      if (options?.silent) return;
      const message = err instanceof Error ? err.message : String(err);
      // Use stderr to avoid polluting structured output (JSON mode, MCP)
      console.error(`[cleanup] ${context}: ${message}`);
    },
  );
}
