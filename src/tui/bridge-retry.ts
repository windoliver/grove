export const BRIDGE_CONNECT_ATTEMPTS = 16;
export const BRIDGE_CONNECT_MAX_BACKOFF_MS = 5000;

export interface BridgeConnectable {
  connect(): Promise<void>;
}

export interface BridgeConnectRetryOptions {
  readonly attempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onAttemptFailure?: (attempt: number, attempts: number, detail: string) => void;
}

export function bridgeConnectDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** Math.max(0, attempt - 1), BRIDGE_CONNECT_MAX_BACKOFF_MS);
}

export async function connectBridgeWithRetry(
  bridge: BridgeConnectable,
  options: BridgeConnectRetryOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? BRIDGE_CONNECT_ATTEMPTS;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await bridge.connect();
      return;
    } catch (err) {
      lastErr = err;
      const detail = err instanceof Error ? err.message : String(err);
      options.onAttemptFailure?.(attempt, attempts, detail);
      if (attempt < attempts) {
        await sleep(bridgeConnectDelayMs(attempt));
      }
    }
  }

  throw lastErr;
}
