/**
 * Acceptance test for issue #293 — criterion #2.
 *
 * A WatchClient driven against a real in-process grove-server that has
 * a tiny ring buffer survives a simulated kill -9 + sleep past retention
 * by relisting via the A5 handshake. Every contribution surfaces (via
 * either RELIST or ADDED) with no missed entities.
 *
 * Sizing: maxEventsPerKey=2 + 5 writes during pause guarantees
 * `oldestRv >= lastSeenRv + 2`, which is the condition the server uses to
 * raise StaleResourceVersionError. (See WatchHub.subscribe: trigger is
 * `fromRv < oldestRv - 1n`.)
 */

import { describe, expect, test } from "bun:test";
import type { ContributionEntity } from "../core/entity.js";
import { WatchClient, type WatchClientEvent } from "../core/watch-client.js";
import { createTestApp, makeManifestBody, TEST_AUTH_HEADERS } from "./test-helpers.js";

describe("WatchClient survives retention gap (issue #293 acceptance #2)", () => {
  test("client relists across retention gap with no missed events", async () => {
    const now = 1_000_000;
    const { app } = createTestApp({
      watchHubOptions: {
        maxAgeMsPerKey: 60_000, // age not the trigger; capacity is
        maxEventsPerKey: 2,
        now: () => now,
      },
    });

    // app.request is a Hono helper that turns a path + RequestInit into a
    // Response. WatchClient expects a base URL + WHATWG fetch. Adapt by
    // intercepting the URL prefix and forwarding to app.request.
    const adaptedFetch: typeof fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const path = url.replace(/^http:\/\/test/, "");
      return app.request(path, init);
    }) as typeof fetch;

    const seen: WatchClientEvent[] = [];
    const ac = new AbortController();
    let paused = false;
    // Track per-watch-request abort controllers so we can cancel the current
    // SSE stream when paused=true is set.
    const activeWatchAcs = new Set<AbortController>();
    const pauseGate: typeof fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/api/watch") && !url.includes("/api/watch/metrics")) {
        if (paused) {
          // Simulate disconnect: return 503 so streamWatch sees !res.ok and ends.
          return new Response("", { status: 503 });
        }
        // Wrap with a per-request abort controller so we can kill the open
        // SSE stream when we transition to paused.
        const watchAc = new AbortController();
        activeWatchAcs.add(watchAc);
        // Chain outer abort signal into this per-watch controller.
        ac.signal.addEventListener("abort", () => watchAc.abort(), { once: true });
        const combinedInit = { ...init, signal: watchAc.signal };
        const res = await adaptedFetch(input, combinedInit);
        // Wrap the body so we know when the consumer is done (and can clean up
        // the ac from the active set). We don't need strict cleanup here since
        // killActiveWatches() just iterates the set and aborts.
        if (res.body) {
          const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
          void res.body
            .pipeTo(writable)
            .catch(() => {
              /* stream aborted — expected when we kill active watches */
            })
            .finally(() => {
              activeWatchAcs.delete(watchAc);
            });
          return new Response(readable, {
            status: res.status,
            headers: res.headers,
          });
        }
        activeWatchAcs.delete(watchAc);
        return res;
      }
      return adaptedFetch(input, init);
    }) as typeof fetch;

    // Abort all active watch streams (simulates network kill).
    const killActiveWatches = (): void => {
      for (const watchAc of [...activeWatchAcs]) {
        watchAc.abort();
      }
    };

    const client = new WatchClient({
      baseUrl: "http://test",
      kind: "Contribution",
      authHeader: TEST_AUTH_HEADERS.Authorization as string,
      fetch: pauseGate,
      backoff: { minMs: 5, maxMs: 50, jitter: 0 },
    });

    const running = client.run({
      onEvent: async (e) => {
        seen.push(e);
      },
      signal: ac.signal,
    });

    // Helper to write a contribution with a known summary marker.
    const post = async (marker: string): Promise<void> => {
      const r = await app.request("/api/contributions", {
        method: "POST",
        headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify(makeManifestBody({ summary: marker })),
      });
      expect(r.status).toBe(201);
    };

    // Phase 1: write 3 events and wait for the watcher to surface all 3.
    // Depending on timing the client may list before or after the writes,
    // so m1/m2/m3 can arrive as either RELIST or ADDED — accept either.
    for (const m of ["m1", "m2", "m3"]) await post(m);
    await waitFor(() => {
      const summaries = collectSummaries(seen);
      return summaries.has("m1") && summaries.has("m2") && summaries.has("m3");
    }, 3_000);

    // Phase 2: pause + write 5 more so capacity eviction pushes
    // oldestRv past the client's last-seen rv.
    paused = true;
    killActiveWatches(); // abort the currently open SSE stream immediately
    await sleep(50); // let the aborted watch loop return and enter backoff
    for (const m of ["m4", "m5", "m6", "m7", "m8"]) await post(m);

    // Phase 3: resume. Next watch attempt hits 410 (lastSeenRv=3 is
    // outside the ring whose oldestRv is 7), which forces a relist.
    paused = false;

    await waitFor(() => {
      const summaries = collectSummaries(seen);
      return (
        seen.some((e) => e.op === "RELIST") &&
        ["m4", "m5", "m6", "m7", "m8"].some((m) => summaries.has(m))
      );
    }, 5_000);

    ac.abort();
    await running;

    // Every marker is observed at least once across the run.
    const observed = collectSummaries(seen);
    for (const m of ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"]) {
      expect(observed.has(m)).toBe(true);
    }
    expect(seen.some((e) => e.op === "RELIST")).toBe(true);
  }, 15_000);
});

function collectSummaries(events: readonly WatchClientEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    const summary = (e.entity as ContributionEntity).spec?.summary;
    if (summary) out.add(summary);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error("waitFor timed out");
}
