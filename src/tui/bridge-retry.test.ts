import { describe, expect, test } from "bun:test";
import {
  BRIDGE_CONNECT_ATTEMPTS,
  BRIDGE_CONNECT_MAX_BACKOFF_MS,
  type BridgeConnectable,
  bridgeConnectDelayMs,
  connectBridgeWithRetry,
} from "./bridge-retry.js";

describe("connectBridgeWithRetry", () => {
  test("keeps retrying through Nexus warmup failures", async () => {
    let calls = 0;
    const delays: number[] = [];
    const failures: string[] = [];
    const bridge: BridgeConnectable = {
      async connect(): Promise<void> {
        calls += 1;
        if (calls <= 5) {
          throw new Error("registration failed for role(s) [coder: HTTP 503]");
        }
      },
    };

    await connectBridgeWithRetry(bridge, {
      attempts: 6,
      sleep: async (ms) => {
        delays.push(ms);
      },
      onAttemptFailure: (attempt, attempts, detail) => {
        failures.push(`${attempt}/${attempts}:${detail}`);
      },
    });

    expect(calls).toBe(6);
    expect(failures).toHaveLength(5);
    expect(failures[0]).toContain("1/6:registration failed");
    expect(delays).toEqual([500, 1000, 2000, 4000, BRIDGE_CONNECT_MAX_BACKOFF_MS]);
  });

  test("throws the last startup error when attempts are exhausted", async () => {
    const bridge: BridgeConnectable = {
      async connect(): Promise<void> {
        throw new Error("still warming");
      },
    };

    await expect(
      connectBridgeWithRetry(bridge, {
        attempts: 3,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("still warming");
  });

  test("defaults to a longer startup retry budget", () => {
    expect(BRIDGE_CONNECT_ATTEMPTS).toBeGreaterThanOrEqual(12);
    expect(bridgeConnectDelayMs(8)).toBe(BRIDGE_CONNECT_MAX_BACKOFF_MS);
  });
});
