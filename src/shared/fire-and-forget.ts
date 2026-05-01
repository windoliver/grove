/**
 * Execute a function with best-effort error handling.
 *
 * For sync functions, catches thrown exceptions.
 * For async functions (returning a Promise), catches rejections.
 * Errors are logged to stderr with a label for debugging.
 */
function logFailure(label: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[grove] ${label} failed: ${message}\n`);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return false;
  }
  return typeof (value as { readonly then?: unknown }).then === "function";
}

export function fireAndForget(label: string, fn: () => unknown): void {
  try {
    const result = fn();
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch((err: unknown) => {
        logFailure(label, err);
      });
    }
  } catch (err: unknown) {
    logFailure(label, err);
  }
}
