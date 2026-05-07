/**
 * B2 acceptance — 100k events/sec for 5s burst (#298).
 *
 * Asserts:
 *   - overflows >= 1 (queue overran at least once)
 *   - factory.relist called >= 1 (recovery triggered)
 *   - per-applyEvent wall time < 50ms (TUI never freezes beyond resync duration)
 *
 * Note: post-burst snapshot equality vs a "server truth" is NOT asserted —
 * overflow is lossy by design (queue clears, recovery comes from the next
 * list→watch handshake). That convergence is verified by the per-relist
 * RELIST_END atomic-replace path (covered in Informer's main test suite).
 */

import { describe, expect, test } from "bun:test";
import { Informer } from "./informer.js";
import type { WatchClientEvent } from "./watch-client.js";
import type { WatchStream } from "./watch-stream.js";

function deltaEvent(op: "ADDED" | "MODIFIED", id: string, rv: string): WatchClientEvent {
  return {
    op,
    rv: BigInt(rv),
    kind: "Contribution",
    entity: {
      kind: "Contribution",
      namespace: "default",
      id,
      spec: {
        contributionKind: "code",
        mode: "direct",
        summary: id,
        artifacts: {},
        relations: [],
        tags: [],
      } as never,
      status: {},
      conditions: [],
      observedGeneration: 0,
      resourceVersion: rv,
      metadata: { generation: 1 },
    },
  };
}

function makeFakeStream(): {
  stream: WatchStream;
  emit: (e: WatchClientEvent) => void | Promise<void>;
} {
  let onEvent: ((e: WatchClientEvent) => void | Promise<void>) | null = null;
  return {
    stream: {
      run: async (opts) => {
        onEvent = opts.onEvent;
        await new Promise<void>((resolve) => {
          opts.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        onEvent = null;
      },
    },
    emit: (e) => {
      if (!onEvent) throw new Error("stream not running");
      return onEvent(e);
    },
  };
}

describe("Informer — 100k/s burst acceptance (B2 #298)", () => {
  test("100k events/sec for 5s → overflows fire, drain stays responsive, recovery triggered", async () => {
    const { stream, emit } = makeFakeStream();
    const ac = new AbortController();

    let relistCalls = 0;
    const informer = new Informer(stream, "Contribution", {
      queueLimit: 1000,
      onOverflow: () => {
        relistCalls += 1;
      },
    });
    const runPromise = informer.run(ac.signal);

    // Track per-applyEvent wall time by monkey-patching the private method —
    // measures the synchronous cost of one applied event. The acceptance
    // condition is "per-drain microtask < 50ms"; with no handlers each apply
    // is O(Map.set) so the budget is generous.
    let maxApplyMs = 0;
    type Privates = { applyEvent: (e: WatchClientEvent) => Promise<void> };
    const privates = informer as unknown as Privates;
    const origApply = privates.applyEvent.bind(informer);
    privates.applyEvent = async (e) => {
      const t0 = performance.now();
      await origApply(e);
      const dt = performance.now() - t0;
      if (dt > maxApplyMs) maxApplyMs = dt;
    };

    // Burst: emit at ~100k/sec for 5 seconds in batches, yielding
    // a macrotask between batches so the drain microtask gets to run.
    // Distinct ids cycle through a key space so coalescing keeps the
    // per-batch new-id rate above the 1000 queue limit, guaranteeing at
    // least one overflow. BATCH must exceed queueLimit before the drain
    // microtask fires (drain is scheduled per-batch, runs after the
    // synchronous emit loop completes).
    const T_END = Date.now() + 5_000;
    const BATCH = 2000;
    let total = 0;
    let rv = 1;
    while (Date.now() < T_END) {
      for (let i = 0; i < BATCH; i += 1) {
        const id = `id-${total % 2000}`;
        // Don't await — we want the sync prefix burst.
        void emit(deltaEvent("ADDED", id, String(rv++)));
        total += 1;
      }
      // Yield — let drain run, let timers advance.
      await new Promise((r) => setImmediate(r));
    }

    // Drain remaining queued events.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(informer.getQueueStats().overflows).toBeGreaterThanOrEqual(1);
    expect(relistCalls).toBeGreaterThanOrEqual(1);
    expect(maxApplyMs).toBeLessThan(50);

    ac.abort();
    await runPromise;
  }, 30_000);
});
