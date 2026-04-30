import { describe, expect, test } from "bun:test";
import { WatchClient, type WatchClientEvent } from "./watch-client.js";

/** Mock fetch returning canned list and watch responses. */
function makeFetch(
  list: { items: unknown[]; listResourceVersion: string },
  watchEvents: string[],
): typeof fetch {
  return (async (input, _init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("/api/list")) {
      return new Response(JSON.stringify(list), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/watch")) {
      const body = watchEvents.join("");
      return new Response(body, {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

const ENTITY_A = {
  envelope: { kind: "Contribution", id: "cid-a" },
  data: { cid: "cid-a", summary: "a" },
};
const ENTITY_B = {
  envelope: { kind: "Contribution", id: "cid-b" },
  data: { cid: "cid-b", summary: "b" },
};

function sse(event: string, data: unknown, id?: string): string {
  const idLine = id ? `id: ${id}\n` : "";
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("WatchClient happy path", () => {
  test("emits RELIST_BEGIN, RELIST per item, RELIST_END, then data ops", async () => {
    const seen: WatchClientEvent[] = [];
    const fetchImpl = makeFetch({ items: [ENTITY_A], listResourceVersion: "5" }, [
      sse("ADDED", { rv: "6", kind: "Contribution", entity: ENTITY_B }, "6"),
    ]);
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
    });
    const ac = new AbortController();
    const running = client.run({
      onEvent: async (e) => {
        seen.push(e);
        if (e.op === "ADDED") ac.abort();
      },
      signal: ac.signal,
    });
    await running;

    expect(seen.map((e) => e.op)).toEqual(["RELIST_BEGIN", "RELIST", "RELIST_END", "ADDED"]);
    expect(seen[0]?.entity).toBeNull();
    expect(seen[0]?.rv).toBe(5n);
    expect((seen[1]?.entity as { envelope: { id: string } }).envelope.id).toBe("cid-a");
    expect(seen[1]?.rv).toBe(5n);
    expect(seen[2]?.entity).toBeNull();
    expect(seen[2]?.rv).toBe(5n);
    expect(seen[3]?.op).toBe("ADDED");
    expect(seen[3]?.rv).toBe(6n);
  });

  test("empty snapshot still emits RELIST_BEGIN + RELIST_END (no items in between)", async () => {
    const seen: WatchClientEvent[] = [];
    const fetchImpl = makeFetch({ items: [], listResourceVersion: "5" }, [
      sse("ADDED", { rv: "6", kind: "Contribution", entity: ENTITY_A }, "6"),
    ]);
    const ac = new AbortController();
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
    });
    await client.run({
      onEvent: async (e) => {
        seen.push(e);
        if (e.op === "ADDED") ac.abort();
      },
      signal: ac.signal,
    });
    expect(seen.map((e) => e.op)).toEqual(["RELIST_BEGIN", "RELIST_END", "ADDED"]);
  });
});

/**
 * Helper: chained fetch that returns scripted responses in order. Each call
 * matches a (urlPattern, body) pair. Throws if the script runs out.
 */
function scriptedFetch(
  steps: Array<{ urlPattern: string; body?: string; status?: number; json?: unknown }>,
): typeof fetch {
  let i = 0;
  return (async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (i >= steps.length) {
      throw new Error(`scripted fetch exhausted at ${url}`);
    }
    const step = steps[i] as (typeof steps)[number];
    i += 1;
    if (!url.includes(step.urlPattern)) {
      throw new Error(`expected url to contain ${step.urlPattern}, got ${url}`);
    }
    if (step.json !== undefined) {
      return new Response(JSON.stringify(step.json), {
        status: step.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(step.body ?? "", {
      status: step.status ?? 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;
}

describe("WatchClient relist on 410", () => {
  test("ERROR{code:410} triggers relist + new RELIST events", async () => {
    const seen: WatchClientEvent[] = [];
    const fetchImpl = scriptedFetch([
      { urlPattern: "/api/list", json: { items: [ENTITY_A], listResourceVersion: "5" } },
      { urlPattern: "/api/watch", body: sse("ERROR", { code: 410, reason: "expired" }, "5") },
      { urlPattern: "/api/list", json: { items: [ENTITY_B], listResourceVersion: "10" } },
      { urlPattern: "/api/watch", body: "" },
    ]);
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    const ac = new AbortController();
    const running = client.run({
      onEvent: async (e) => {
        seen.push(e);
        const relists = seen.filter((s) => s.op === "RELIST");
        if (relists.length >= 2) ac.abort();
      },
      signal: ac.signal,
    });
    await running;

    const relists = seen.filter((s) => s.op === "RELIST");
    expect(relists.length).toBe(2);
    expect((relists[0]?.entity as { envelope: { id: string } }).envelope.id).toBe("cid-a");
    expect((relists[1]?.entity as { envelope: { id: string } }).envelope.id).toBe("cid-b");
    expect(relists[1]?.rv).toBe(10n);
  });

  test("ERROR{code:503} triggers relist same as 410", async () => {
    const seen: WatchClientEvent[] = [];
    const fetchImpl = scriptedFetch([
      { urlPattern: "/api/list", json: { items: [ENTITY_A], listResourceVersion: "5" } },
      {
        urlPattern: "/api/watch",
        body: sse("ERROR", { code: 503, reason: "buffer_overflow" }, "5"),
      },
      { urlPattern: "/api/list", json: { items: [ENTITY_B], listResourceVersion: "9" } },
      { urlPattern: "/api/watch", body: "" },
    ]);
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    const ac = new AbortController();
    const running = client.run({
      onEvent: async (e) => {
        seen.push(e);
        const relists = seen.filter((s) => s.op === "RELIST");
        if (relists.length >= 2) ac.abort();
      },
      signal: ac.signal,
    });
    await running;
    expect(seen.filter((s) => s.op === "RELIST").length).toBe(2);
  });

  test("backoff sleeps between attempts when minMs > 0", async () => {
    const sleeps: number[] = [];
    // Use TCP-close (empty SSE body, no ERROR frame) to drive the exponential
    // ladder. With fast-resume, ended cycles skip the list and go straight to
    // the next watch. One initial list, then repeated watch-only cycles.
    const fetchImpl = scriptedFetch([
      { urlPattern: "/api/list", json: { items: [], listResourceVersion: "0" } },
      { urlPattern: "/api/watch", body: "" }, // ended → sleep(10), advance to 20
      { urlPattern: "/api/watch", body: "" }, // ended → sleep(20), advance to 40
      { urlPattern: "/api/watch", body: "" }, // ended → sleep(40), advance to 80
      { urlPattern: "/api/watch", body: "" }, // never reached
    ]);
    const ac = new AbortController();
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 10, maxMs: 100, jitter: 0 },
    });
    (client as unknown as { onBackoff?: (ms: number) => void }).onBackoff = (ms: number) => {
      sleeps.push(ms);
      if (sleeps.length >= 3) ac.abort();
    };
    await client.run({ onEvent: () => {}, signal: ac.signal });
    expect(sleeps).toEqual([10, 20, 40]);
  });

  test("ended after data delivery resets backoff", async () => {
    const sleeps: number[] = [];
    // Two empty-watch ended cycles climb to 20ms, then a watch that delivers
    // one ADDED event before ending must reset backoff to 10ms.
    const fetchImpl = scriptedFetch([
      { urlPattern: "/api/list", json: { items: [], listResourceVersion: "0" } },
      { urlPattern: "/api/watch", body: "" }, // ended (no data) → sleep(10), advance to 20
      { urlPattern: "/api/watch", body: "" }, // ended (no data) → sleep(20), advance to 40
      {
        urlPattern: "/api/watch",
        body: sse("ADDED", { rv: "1", kind: "Contribution", entity: ENTITY_A }, "1"),
      }, // ended after delivering data → reset, sleep(10)
      { urlPattern: "/api/watch", body: "" },
    ]);
    const ac = new AbortController();
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 10, maxMs: 100, jitter: 0 },
    });
    (client as unknown as { onBackoff?: (ms: number) => void }).onBackoff = (ms: number) => {
      sleeps.push(ms);
      if (sleeps.length >= 3) ac.abort();
    };
    await client.run({ onEvent: () => undefined, signal: ac.signal });
    expect(sleeps).toEqual([10, 20, 10]);
  });

  test("HTTP 503 from watch triggers relist (not fast resume)", async () => {
    const fetchImpl = scriptedFetch([
      { urlPattern: "/api/list", json: { items: [ENTITY_A], listResourceVersion: "5" } },
      { urlPattern: "/api/watch", body: "", status: 503 },
      { urlPattern: "/api/list", json: { items: [ENTITY_B], listResourceVersion: "9" } },
      { urlPattern: "/api/watch", body: "" },
    ]);
    const seen: WatchClientEvent[] = [];
    const ac = new AbortController();
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    const running = client.run({
      onEvent: async (e) => {
        seen.push(e);
        const relists = seen.filter((s) => s.op === "RELIST");
        if (relists.length >= 2) ac.abort();
      },
      signal: ac.signal,
    });
    await running;
    // 2 RELIST events: one per list (the second after relist due to 503).
    expect(seen.filter((s) => s.op === "RELIST").length).toBe(2);
  });

  test("malformed data frame forces relist (BOOKMARK cannot ack past skipped event)", async () => {
    const seen: WatchClientEvent[] = [];
    // Stream 1: malformed ADDED (no rv) followed by BOOKMARK rv=99. Without
    // the relist policy, BOOKMARK would silently advance lastRv past the
    // dropped data event. The expected behavior is to relist immediately.
    const fetchImpl = scriptedFetch([
      { urlPattern: "/api/list", json: { items: [], listResourceVersion: "0" } },
      {
        urlPattern: "/api/watch",
        body: `${sse(
          "ADDED",
          { rv: "not-a-number", kind: "Contribution", entity: ENTITY_A },
          "1",
        )}${sse("BOOKMARK", { rv: "99" }, "99")}`,
      },
      // After relist, list returns ENTITY_B at rv=2 → assert this snapshot is delivered.
      { urlPattern: "/api/list", json: { items: [ENTITY_B], listResourceVersion: "2" } },
      { urlPattern: "/api/watch", body: "" },
    ]);
    const ac = new AbortController();
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    const running = client.run({
      onEvent: async (e) => {
        seen.push(e);
        if (e.op === "RELIST" && (e.entity as { envelope: { id: string } }).envelope.id === "cid-b")
          ac.abort();
      },
      signal: ac.signal,
    });
    await running;
    // The malformed ADDED is not delivered; the relist surfaces ENTITY_B.
    const dataOps = seen.filter((e) => e.op === "ADDED");
    expect(dataOps.length).toBe(0);
    const relists = seen.filter((e) => e.op === "RELIST");
    expect(relists.length).toBe(1);
    expect((relists[0]?.entity as { envelope: { id: string } }).envelope.id).toBe("cid-b");
  });

  test("ERROR{code:410} resets backoff (relist is a clean slate)", async () => {
    const sleeps: number[] = [];
    // Two TCP-close cycles climb backoff to 20ms, then a 410 should reset to 10ms.
    // With fast-resume, ended cycles skip the list — only the 410 triggers a relist.
    const fetchImpl = scriptedFetch([
      { urlPattern: "/api/list", json: { items: [], listResourceVersion: "0" } },
      { urlPattern: "/api/watch", body: "" }, // ended → sleep(10), advance to 20
      { urlPattern: "/api/watch", body: "" }, // ended → sleep(20), advance to 40
      { urlPattern: "/api/watch", body: sse("ERROR", { code: 410 }, "0") }, // 410 → reset, sleep(10)
      { urlPattern: "/api/list", json: { items: [], listResourceVersion: "0" } },
      { urlPattern: "/api/watch", body: "" }, // never reached
    ]);
    const ac = new AbortController();
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 10, maxMs: 100, jitter: 0 },
    });
    (client as unknown as { onBackoff?: (ms: number) => void }).onBackoff = (ms: number) => {
      sleeps.push(ms);
      if (sleeps.length >= 3) ac.abort();
    };
    await client.run({ onEvent: () => {}, signal: ac.signal });
    expect(sleeps).toEqual([10, 20, 10]);
  });
});

describe("WatchClient fast resume on TCP close", () => {
  test("reopens watch from last-seen rv after stream ends without ERROR", async () => {
    const seen: WatchClientEvent[] = [];
    const watchUrls: string[] = [];
    const ac = new AbortController();
    const fetchImpl = (async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/api/list")) {
        return new Response(JSON.stringify({ items: [], listResourceVersion: "5" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/watch")) {
        watchUrls.push(url);
        if (watchUrls.length === 1) {
          // First watch: emit ADDED rv=6 then end.
          return new Response(
            sse("ADDED", { rv: "6", kind: "Contribution", entity: ENTITY_A }, "6"),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        }
        // Second watch observed → fire abort so the loop unwinds.
        ac.abort();
        return new Response("", {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    const running = client.run({
      onEvent: async (e) => {
        seen.push(e);
      },
      signal: ac.signal,
    });
    await running;

    expect(watchUrls.length).toBeGreaterThanOrEqual(2);
    // First watch resumes from listRv=5; second resumes from last-seen rv=6.
    expect(watchUrls[0]).toContain("resumeFrom=5");
    expect(watchUrls[1]).toContain("resumeFrom=6");
    expect(seen.filter((e) => e.op === "RELIST").length).toBe(0); // no relist
  });

  test("first ended-without-event uses listRv as resumeFrom", async () => {
    const ac = new AbortController();
    const fetchImpl = scriptedFetch([
      { urlPattern: "/api/list", json: { items: [], listResourceVersion: "5" } },
      { urlPattern: "/api/watch", body: "" }, // ended → fast resume from rv=5
      { urlPattern: "/api/watch", body: "" }, // ended → fast resume from rv=5 again
      { urlPattern: "/api/watch", body: "" }, // third watch → abort
    ]);
    // Override: wrap scriptedFetch to capture urls and abort on third watch
    const watchUrls: string[] = [];
    const wrappedFetch: typeof fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/api/watch")) {
        watchUrls.push(url);
        if (watchUrls.length >= 3) ac.abort();
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: wrappedFetch,
      backoff: { minMs: 1, maxMs: 1, jitter: 0 },
    });
    await client.run({
      onEvent: () => undefined,
      signal: ac.signal,
    });

    expect(watchUrls.length).toBeGreaterThanOrEqual(2);
    for (const u of watchUrls) {
      expect(u).toContain("resumeFrom=5");
    }
  });
});

describe("WatchClient relist boundary invariant", () => {
  const E_X = { id: "cid-x", resourceVersion: "0", spec: { summary: "x" } };

  test("abort during RELIST_BEGIN's onEvent still emits RELIST_END", async () => {
    const seen: WatchClientEvent[] = [];
    const ac = new AbortController();
    const fetchImpl = makeFetch({ items: [E_X], listResourceVersion: "5" }, []);
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    await client.run({
      onEvent: async (e) => {
        seen.push(e);
        if (e.op === "RELIST_BEGIN") ac.abort();
      },
      signal: ac.signal,
    });
    // BEGIN was delivered; END must follow even though the consumer aborted
    // immediately. No RELIST item is emitted (loop short-circuits on
    // signal.aborted before processing items).
    expect(seen.map((e) => e.op)).toEqual(["RELIST_BEGIN", "RELIST_END"]);
  });

  test("abort during a RELIST item still emits RELIST_END", async () => {
    const seen: WatchClientEvent[] = [];
    const ac = new AbortController();
    const fetchImpl = makeFetch(
      { items: [E_X, E_X, E_X], listResourceVersion: "5" },
      [],
    );
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    await client.run({
      onEvent: async (e) => {
        seen.push(e);
        if (e.op === "RELIST") ac.abort();
      },
      signal: ac.signal,
    });
    // BEGIN, one RELIST item (the one that triggered abort), then END.
    // The remaining 2 items are skipped.
    const ops = seen.map((e) => e.op);
    expect(ops[0]).toBe("RELIST_BEGIN");
    expect(ops[ops.length - 1]).toBe("RELIST_END");
    expect(seen.filter((e) => e.op === "RELIST").length).toBeGreaterThanOrEqual(1);
  });

  test("RELIST_END handler failure (no abort, no prior error) propagates", async () => {
    // RELIST_END is the consumer's commit barrier — a failure there means
    // the snapshot replace is half-applied. The watcher must NOT silently
    // advance to delta mode with a partially committed cache.
    const fetchImpl = makeFetch({ items: [E_X], listResourceVersion: "5" }, []);
    const ac = new AbortController();
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    await expect(
      client.run({
        onEvent: async (e) => {
          if (e.op === "RELIST_END") throw new Error("commit failed");
        },
        signal: ac.signal,
      }),
    ).rejects.toThrow(/commit failed/);
  });

  test("RELIST_END handler failure DURING abort is swallowed (teardown)", async () => {
    // If the consumer is already shutting down (abort in flight), a noisy
    // RELIST_END must not mask the abort.
    const fetchImpl = makeFetch({ items: [E_X], listResourceVersion: "5" }, []);
    const ac = new AbortController();
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    // Should resolve cleanly (not reject) — the END error is suppressed
    // because abort is in flight.
    await client.run({
      onEvent: async (e) => {
        if (e.op === "RELIST_BEGIN") ac.abort();
        if (e.op === "RELIST_END") throw new Error("noisy teardown");
      },
      signal: ac.signal,
    });
  });

  test("throw inside RELIST_BEGIN onEvent does NOT emit RELIST_END", async () => {
    // If BEGIN failed to be delivered (handler threw), the consumer never
    // entered replace mode — emitting END would invent a transition that
    // never started.
    const seen: WatchClientEvent[] = [];
    const fetchImpl = makeFetch({ items: [E_X], listResourceVersion: "5" }, []);
    const ac = new AbortController();
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    await expect(
      client.run({
        onEvent: async (e) => {
          if (e.op === "RELIST_BEGIN") throw new Error("consumer rejected BEGIN");
          seen.push(e);
        },
        signal: ac.signal,
      }),
    ).rejects.toThrow(/consumer rejected BEGIN/);
    // No END emitted because BEGIN never completed.
    expect(seen.some((e) => e.op === "RELIST_END")).toBe(false);
  });
});

describe("WatchClient snapshot dedup (list/watch race)", () => {
  // The dedup uses entity.id + entity.resourceVersion (per ContributionEntity).
  // Local fixtures shaped like real entities so the dedup keys exist.
  const E_A = { id: "cid-a", resourceVersion: "0", spec: { summary: "a" } };
  const E_B = { id: "cid-b", resourceVersion: "0", spec: { summary: "b" } };

  /**
   * Watch fetcher that returns one canned watch body, then aborts the run
   * on the next watch call. This prevents the loop from spinning when the
   * scripted fetch is exhausted (which would otherwise hammer the
   * fast-resume path forever via the transport-error catch).
   */
  function singleWatchThenAbort(
    listJson: unknown,
    watchBody: string,
    ac: AbortController,
  ): typeof fetch {
    let watchCalls = 0;
    return (async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/api/list")) {
        return new Response(JSON.stringify(listJson), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/watch")) {
        watchCalls += 1;
        if (watchCalls === 1) {
          return new Response(watchBody, {
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        // Subsequent watch attempts: signal end, abort the run.
        ac.abort();
        return new Response("", { headers: { "Content-Type": "text/event-stream" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
  }

  test("ADDED with same (id, resourceVersion) as a snapshot item is suppressed", async () => {
    const seen: WatchClientEvent[] = [];
    // E_A is in the snapshot at listRv=5 with resourceVersion "0".
    // The watch then replays an ADDED for the same entity at watch-rv=6
    // (the race-window duplicate). It must not surface as ADDED.
    const ac = new AbortController();
    const fetchImpl = singleWatchThenAbort(
      { items: [E_A], listResourceVersion: "5" },
      sse("ADDED", { rv: "6", kind: "Contribution", entity: E_A }, "6"),
      ac,
    );
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    const running = client.run({
      onEvent: async (e) => {
        seen.push(e);
      },
      signal: ac.signal,
    });
    await running;
    // RELIST_BEGIN, RELIST(A), RELIST_END — and crucially NO ADDED for A.
    const ops = seen.map((e) => e.op);
    expect(ops).toEqual(["RELIST_BEGIN", "RELIST", "RELIST_END"]);
    expect(seen.some((e) => e.op === "ADDED")).toBe(false);
  });

  test("MODIFIED with different resourceVersion (real update) is forwarded", async () => {
    const seen: WatchClientEvent[] = [];
    // Snapshot has E_A at resourceVersion "0". Watch sends a MODIFIED
    // with resourceVersion "1" — a real update, NOT a snapshot replay.
    const updatedA = { ...E_A, resourceVersion: "1" };
    const ac = new AbortController();
    const fetchImpl = singleWatchThenAbort(
      { items: [E_A], listResourceVersion: "5" },
      sse("MODIFIED", { rv: "6", kind: "Contribution", entity: updatedA }, "6"),
      ac,
    );
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    await client.run({ onEvent: (e) => seen.push(e), signal: ac.signal });
    const modified = seen.find((e) => e.op === "MODIFIED");
    expect(modified).toBeDefined();
    expect((modified?.entity as { resourceVersion: string }).resourceVersion).toBe("1");
  });

  test("DELETED for snapshot entity is forwarded (never deduped)", async () => {
    const seen: WatchClientEvent[] = [];
    const ac = new AbortController();
    const fetchImpl = singleWatchThenAbort(
      { items: [E_A], listResourceVersion: "5" },
      sse("DELETED", { rv: "6", kind: "Contribution", entity: E_A }, "6"),
      ac,
    );
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    await client.run({ onEvent: (e) => seen.push(e), signal: ac.signal });
    expect(seen.some((e) => e.op === "DELETED")).toBe(true);
  });

  test("dedup window is reset on every RELIST snapshot", async () => {
    // Round 1: snapshot has A. Round 2 (after relist): snapshot has only B
    // (A no longer present). A subsequent ADDED for A at the SAME
    // resourceVersion must NOT be deduped — A is not in the new window.
    const seen: WatchClientEvent[] = [];
    const ac = new AbortController();
    let listCalls = 0;
    let watchCalls = 0;
    const fetchImpl: typeof fetch = (async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/api/list")) {
        listCalls += 1;
        const body =
          listCalls === 1
            ? { items: [E_A], listResourceVersion: "5" }
            : { items: [E_B], listResourceVersion: "10" };
        return new Response(JSON.stringify(body), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/watch")) {
        watchCalls += 1;
        if (watchCalls === 1) {
          // First watch: 410 → triggers relist for round 2.
          return new Response(sse("ERROR", { code: 410 }, "5"), {
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        if (watchCalls === 2) {
          // Second watch: ADDED for A. After round-2 relist, A is NOT in
          // the snapshot window, so this must surface (no dedup).
          return new Response(
            sse("ADDED", { rv: "11", kind: "Contribution", entity: E_A }, "11"),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        }
        ac.abort();
        return new Response("", { headers: { "Content-Type": "text/event-stream" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    await client.run({ onEvent: (e) => seen.push(e), signal: ac.signal });
    const addedA = seen.find(
      (e) => e.op === "ADDED" && (e.entity as { id: string } | null)?.id === "cid-a",
    );
    expect(addedA).toBeDefined();
  });
});

describe("WatchClient terminal errors", () => {
  test("rejects on HTTP 401 from list", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ code: "UNAUTHENTICATED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const ac = new AbortController();
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    await expect(client.run({ onEvent: () => undefined, signal: ac.signal })).rejects.toThrow(
      /401|UNAUTHENTICATED|list failed/,
    );
  });

  test("rejects on watch ERROR with non-410/503 code", async () => {
    const fetchImpl = scriptedFetch([
      { urlPattern: "/api/list", json: { items: [], listResourceVersion: "0" } },
      {
        urlPattern: "/api/watch",
        body: sse("ERROR", { code: 400, reason: "validation_error" }, "0"),
      },
    ]);
    const ac = new AbortController();
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    await expect(client.run({ onEvent: () => undefined, signal: ac.signal })).rejects.toThrow(
      /400|terminal/,
    );
  });

  test("rejects on HTTP 401 from /api/watch (not infinite retry)", async () => {
    const fetchImpl = scriptedFetch([
      { urlPattern: "/api/list", json: { items: [], listResourceVersion: "0" } },
      { urlPattern: "/api/watch", body: "", status: 401 },
    ]);
    const ac = new AbortController();
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    await expect(client.run({ onEvent: () => undefined, signal: ac.signal })).rejects.toThrow(
      /401|watch failed/,
    );
  });

  test("rejects on HTTP 500 from /api/watch (server bug, not retryable)", async () => {
    const fetchImpl = scriptedFetch([
      { urlPattern: "/api/list", json: { items: [], listResourceVersion: "0" } },
      { urlPattern: "/api/watch", body: "", status: 500 },
    ]);
    const ac = new AbortController();
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    await expect(client.run({ onEvent: () => undefined, signal: ac.signal })).rejects.toThrow(
      /500|watch failed/,
    );
  });
});

describe("WatchClient list-phase transient failures", () => {
  test("transport reject on /api/list retries with backoff (does not kill loop)", async () => {
    let listCalls = 0;
    const ac = new AbortController();
    const fetchImpl = (async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/api/list")) {
        listCalls += 1;
        if (listCalls < 3) throw new Error("ECONNRESET");
        return new Response(JSON.stringify({ items: [], listResourceVersion: "0" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      // First /api/watch we abort.
      ac.abort();
      return new Response("", { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    // Should NOT reject — list transport failures are retried.
    await client.run({ onEvent: () => undefined, signal: ac.signal });
    expect(listCalls).toBeGreaterThanOrEqual(3);
  });

  test("HTTP 503 on /api/list retries with backoff", async () => {
    let listCalls = 0;
    const ac = new AbortController();
    const fetchImpl = (async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/api/list")) {
        listCalls += 1;
        if (listCalls < 3) {
          return new Response("", { status: 503 });
        }
        return new Response(JSON.stringify({ items: [], listResourceVersion: "0" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      ac.abort();
      return new Response("", { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    await client.run({ onEvent: () => undefined, signal: ac.signal });
    expect(listCalls).toBeGreaterThanOrEqual(3);
  });

  test("HTTP 501 NOT_CONFIGURED on /api/list is terminal (not retried forever)", async () => {
    const fetchImpl = scriptedFetch([
      { urlPattern: "/api/list", body: "", status: 501 },
    ]);
    const ac = new AbortController();
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    await expect(client.run({ onEvent: () => undefined, signal: ac.signal })).rejects.toThrow(
      /501|list failed/,
    );
  });

  test("HTTP 500 on /api/list is terminal (configuration/server bug)", async () => {
    const fetchImpl = scriptedFetch([
      { urlPattern: "/api/list", body: "", status: 500 },
    ]);
    const ac = new AbortController();
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    await expect(client.run({ onEvent: () => undefined, signal: ac.signal })).rejects.toThrow(
      /500|list failed/,
    );
  });

  test("HTTP 4xx on /api/list (other than auth-style) is still terminal", async () => {
    // 400 is a server contract error — retrying would loop forever.
    const fetchImpl = scriptedFetch([
      { urlPattern: "/api/list", body: "", status: 400 },
    ]);
    const ac = new AbortController();
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    await expect(client.run({ onEvent: () => undefined, signal: ac.signal })).rejects.toThrow(
      /400|list failed/,
    );
  });
});

describe("WatchClient transport errors", () => {
  test("fetch rejection mid-loop is recoverable (fast resume from lastRv)", async () => {
    let watchCalls = 0;
    const ac = new AbortController();
    const fetchImpl = (async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/api/list")) {
        return new Response(JSON.stringify({ items: [], listResourceVersion: "5" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      watchCalls += 1;
      if (watchCalls === 1) throw new Error("ECONNRESET");
      // Second watch must resume from rv=5, then end. Abort on third call.
      if (watchCalls >= 3) ac.abort();
      return new Response("", { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    // Should NOT reject — transport error is fast-resumed.
    await client.run({ onEvent: () => undefined, signal: ac.signal });
    expect(watchCalls).toBeGreaterThanOrEqual(2);
  });

  test("mid-stream reader.read rejection is recoverable", async () => {
    let watchCalls = 0;
    const ac = new AbortController();
    const fetchImpl = (async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/api/list")) {
        return new Response(JSON.stringify({ items: [], listResourceVersion: "5" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      watchCalls += 1;
      if (watchCalls === 1) {
        // Stream that errors mid-read.
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event: BOOKMARK\ndata: {}\n\n"));
            queueMicrotask(() => controller.error(new Error("RST")));
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      }
      if (watchCalls >= 2) ac.abort();
      return new Response("", { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    // Should NOT reject — mid-stream read failure → fast resume.
    await client.run({ onEvent: () => undefined, signal: ac.signal });
    expect(watchCalls).toBeGreaterThanOrEqual(2);
  });
});

describe("WatchClient onEvent semantics", () => {
  test("awaits each onEvent before processing the next", async () => {
    const order: string[] = [];
    let resolveFirst: (() => void) | undefined;
    const firstDone = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const fetchImpl = makeFetch({ items: [], listResourceVersion: "5" }, [
      sse("ADDED", { rv: "6", kind: "Contribution", entity: ENTITY_A }, "6"),
      sse("ADDED", { rv: "7", kind: "Contribution", entity: ENTITY_B }, "7"),
    ]);
    const ac = new AbortController();
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    const running = client.run({
      onEvent: async (e) => {
        // Boundary events fire synchronously around the snapshot; only
        // assert serialisation of the data ops.
        if (e.op === "RELIST_BEGIN" || e.op === "RELIST_END") return;
        order.push(`enter:${e.rv}`);
        if (e.rv === 6n) await firstDone;
        order.push(`exit:${e.rv}`);
        if (e.rv === 7n) ac.abort();
      },
      signal: ac.signal,
    });
    // Give the loop a tick to enter onEvent for rv=6.
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["enter:6"]);
    resolveFirst?.();
    await running;
    expect(order).toEqual(["enter:6", "exit:6", "enter:7", "exit:7"]);
  });

  test("abort during in-flight onEvent waits for callback to settle", async () => {
    let callbackResolved = false;
    let onEventEntered = false;
    const fetchImpl = makeFetch({ items: [ENTITY_A], listResourceVersion: "5" }, []);
    const ac = new AbortController();
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    const running = client.run({
      onEvent: async () => {
        onEventEntered = true;
        ac.abort(); // abort while we are inside onEvent
        await new Promise((r) => setTimeout(r, 20));
        callbackResolved = true;
      },
      signal: ac.signal,
    });
    await running;
    expect(onEventEntered).toBe(true);
    expect(callbackResolved).toBe(true);
  });
});
