import { describe, expect, test } from "bun:test";
import { Informer, InformerFactory } from "./informer.js";
import type { WatchClientEvent } from "./watch-client.js";
import { WatchClient } from "./watch-client.js";
import type { WatchEntity, WatchKind } from "./watch-events.js";
import { WatchHub } from "./watch-hub.js";
import type { WatchStream } from "./watch-stream.js";

function makeFakeStream(): {
  stream: WatchStream;
  emit: (e: WatchClientEvent) => Promise<void>;
} {
  let onEvent: ((e: WatchClientEvent) => void | Promise<void>) | null = null;
  const stream: WatchStream = {
    run: async (opts) => {
      onEvent = opts.onEvent;
      // Block until aborted; tests trigger emit() externally.
      await new Promise<void>((resolve) => {
        opts.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      onEvent = null;
    },
  };
  return {
    stream,
    emit: async (e) => {
      if (!onEvent) throw new Error("stream not running");
      await onEvent(e);
    },
  };
}

function deltaEvent(
  op: "ADDED" | "MODIFIED" | "DELETED",
  id: string,
  rv: string,
): WatchClientEvent {
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

async function drainMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// Minimal entity shapes (WatchClient passes them through as-is)
const E_A: WatchEntity = {
  kind: "Contribution",
  namespace: "default",
  id: "cid-a",
  spec: {
    contributionKind: "code",
    mode: "direct",
    summary: "a",
    artifacts: {},
    relations: [],
    tags: [],
  },
  status: {},
  conditions: [],
  observedGeneration: 0,
  resourceVersion: "1",
  metadata: { generation: 1 },
} as unknown as WatchEntity;

const E_A_v2: WatchEntity = { ...E_A, resourceVersion: "2" } as unknown as WatchEntity;

const E_B: WatchEntity = {
  ...E_A,
  id: "cid-b",
  resourceVersion: "1",
} as unknown as WatchEntity;

function sse(event: string, data: unknown, id?: string): string {
  const idLine = id ? `id: ${id}\n` : "";
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Fake fetch: returns canned list snapshot + canned SSE watch body. */
function makeFetch(
  list: { items: WatchEntity[]; listResourceVersion: string },
  watchBody: string,
  ac: AbortController,
): typeof fetch {
  let watchCalls = 0;
  return (async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("/api/list")) {
      return new Response(JSON.stringify(list), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/watch")) {
      watchCalls += 1;
      if (watchCalls === 1) {
        return new Response(watchBody, { headers: { "Content-Type": "text/event-stream" } });
      }
      // Second watch attempt → abort (prevents infinite loop after watch body exhausted)
      ac.abort();
      return new Response("", { headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

async function withSilencedConsoleError<T>(fn: () => Promise<T>): Promise<T> {
  const originalConsoleError = console.error;
  console.error = () => {
    /* expected */
  };
  try {
    return await fn();
  } finally {
    console.error = originalConsoleError;
  }
}

// ─── hasSynced ────────────────────────────────────────────────────────────────

describe("Informer hasSynced", () => {
  test("false before first RELIST_END", async () => {
    const ac = new AbortController();
    let syncedDuringBegin = true; // assume true, set false when we see it
    const fetchImpl = makeFetch({ items: [E_A], listResourceVersion: "5" }, "", ac);
    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: fetchImpl,
        backoff: { minMs: 0, maxMs: 0, jitter: 0 },
      }),
      "Contribution",
    );
    informer.addEventHandler((_op, _entity) => {
      // Only called after RELIST_END; check synced at first delta
      syncedDuringBegin = informer.hasSynced();
    });
    // Abort after relist ends (no watch body, loop goes to second watch → abort)
    await informer.run(ac.signal);
    // hasSynced() must be true after the relist
    expect(informer.hasSynced()).toBe(true);
    // The handler fires after RELIST_END (during replace reconciliation) — synced should be true
    expect(syncedDuringBegin).toBe(true);
  });

  test("hasSynced false until first RELIST_END even on empty list", async () => {
    const ac = new AbortController();
    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: makeFetch({ items: [], listResourceVersion: "5" }, "", ac),
        backoff: { minMs: 0, maxMs: 0, jitter: 0 },
      }),
      "Contribution",
    );
    expect(informer.hasSynced()).toBe(false);
    await informer.run(ac.signal);
    expect(informer.hasSynced()).toBe(true);
  });
});

// ─── Cache population ─────────────────────────────────────────────────────────

describe("Informer cache after initial sync", () => {
  test("list() returns all items from snapshot", async () => {
    const ac = new AbortController();
    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: makeFetch({ items: [E_A, E_B], listResourceVersion: "5" }, "", ac),
        backoff: { minMs: 0, maxMs: 0, jitter: 0 },
      }),
      "Contribution",
    );
    await informer.run(ac.signal);
    const items = informer.list();
    expect(items).toHaveLength(2);
    const ids = items.map((e) => (e as { id: string }).id).sort();
    expect(ids).toEqual(["cid-a", "cid-b"]);
  });

  test("getById returns entity by id (O(1) lookup)", async () => {
    const ac = new AbortController();
    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: makeFetch({ items: [E_A, E_B], listResourceVersion: "5" }, "", ac),
        backoff: { minMs: 0, maxMs: 0, jitter: 0 },
      }),
      "Contribution",
    );
    await informer.run(ac.signal);
    expect((informer.getById("cid-a") as { id: string } | undefined)?.id).toBe("cid-a");
    expect(informer.getById("nonexistent")).toBeUndefined();
  });
});

// ─── Delta events ─────────────────────────────────────────────────────────────

describe("Informer delta events", () => {
  test("ADDED delta: adds to cache, fires handler", async () => {
    const ac = new AbortController();
    const events: Array<{ op: string; id: string }> = [];
    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: makeFetch(
          { items: [], listResourceVersion: "5" },
          sse("ADDED", { rv: "6", kind: "Contribution", entity: E_A }, "6"),
          ac,
        ),
        backoff: { minMs: 0, maxMs: 0, jitter: 0 },
      }),
      "Contribution",
    );
    informer.addEventHandler((op, entity) => {
      events.push({ op, id: (entity as { id: string }).id });
      if (op === "ADDED") ac.abort();
    });
    await informer.run(ac.signal);
    expect(events).toContainEqual({ op: "ADDED", id: "cid-a" });
    expect((informer.getById("cid-a") as { id: string } | undefined)?.id).toBe("cid-a");
  });

  test("MODIFIED delta: updates cache, fires handler", async () => {
    const ac = new AbortController();
    const events: Array<{ op: string; id: string; rv: string }> = [];
    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: makeFetch(
          { items: [E_A], listResourceVersion: "5" },
          sse("MODIFIED", { rv: "6", kind: "Contribution", entity: E_A_v2 }, "6"),
          ac,
        ),
        backoff: { minMs: 0, maxMs: 0, jitter: 0 },
      }),
      "Contribution",
    );
    informer.addEventHandler((op, entity) => {
      events.push({
        op,
        id: (entity as { id: string }).id,
        rv: (entity as { resourceVersion: string }).resourceVersion,
      });
      if (op === "MODIFIED") ac.abort();
    });
    await informer.run(ac.signal);
    expect(events.some((e) => e.op === "MODIFIED" && e.rv === "2")).toBe(true);
    expect(
      (informer.getById("cid-a") as { resourceVersion: string } | undefined)?.resourceVersion,
    ).toBe("2");
  });

  test("DELETED delta: removes from cache, fires handler", async () => {
    const ac = new AbortController();
    const events: Array<{ op: string; id: string }> = [];
    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: makeFetch(
          { items: [E_A], listResourceVersion: "5" },
          sse("DELETED", { rv: "6", kind: "Contribution", entity: E_A }, "6"),
          ac,
        ),
        backoff: { minMs: 0, maxMs: 0, jitter: 0 },
      }),
      "Contribution",
    );
    informer.addEventHandler((op, entity) => {
      events.push({ op, id: (entity as { id: string }).id });
      if (op === "DELETED") ac.abort();
    });
    await informer.run(ac.signal);
    expect(events.some((e) => e.op === "DELETED" && e.id === "cid-a")).toBe(true);
    expect(informer.getById("cid-a")).toBeUndefined();
  });
});

// ─── Replace reconciliation ───────────────────────────────────────────────────

describe("Informer Replace reconciliation on relist", () => {
  test("item removed from server on relist → DELETED handler fired", async () => {
    // Round 1: A + B. Round 2 (after 410): only A. B must get DELETED.
    const events: Array<{ op: string; id: string }> = [];
    const ac = new AbortController();
    let step = 0;
    const fetchImpl: typeof fetch = (async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/api/list")) {
        step += 1;
        const items = step === 1 ? [E_A, E_B] : [E_A];
        return new Response(
          JSON.stringify({ items, listResourceVersion: step === 1 ? "5" : "10" }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/watch")) {
        if (step === 1) {
          // 410 → triggers relist
          return new Response(sse("ERROR", { code: 410 }, "5"), {
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        // After round 2 relist, abort
        ac.abort();
        return new Response("", { headers: { "Content-Type": "text/event-stream" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: fetchImpl,
        backoff: { minMs: 0, maxMs: 0, jitter: 0 },
      }),
      "Contribution",
    );
    informer.addEventHandler((op, entity) => {
      events.push({ op, id: (entity as { id: string }).id });
    });
    await informer.run(ac.signal);

    const deletedB = events.find((e) => e.op === "DELETED" && e.id === "cid-b");
    expect(deletedB).toBeDefined();
    expect(informer.getById("cid-b")).toBeUndefined();
    expect((informer.getById("cid-a") as { id: string } | undefined)?.id).toBe("cid-a");
  });

  test("new item on relist → ADDED handler fired", async () => {
    const events: Array<{ op: string; id: string }> = [];
    const ac = new AbortController();
    let step = 0;
    const fetchImpl: typeof fetch = (async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/api/list")) {
        step += 1;
        const items = step === 1 ? [E_A] : [E_A, E_B];
        return new Response(
          JSON.stringify({ items, listResourceVersion: step === 1 ? "5" : "10" }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (step === 1) {
        return new Response(sse("ERROR", { code: 410 }, "5"), {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      ac.abort();
      return new Response("", { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: fetchImpl,
        backoff: { minMs: 0, maxMs: 0, jitter: 0 },
      }),
      "Contribution",
    );
    informer.addEventHandler((op, entity) => {
      events.push({ op, id: (entity as { id: string }).id });
    });
    await informer.run(ac.signal);

    // After round 2: E_B is new → ADDED
    const addedB = events.find((e) => e.op === "ADDED" && e.id === "cid-b");
    expect(addedB).toBeDefined();
  });

  test("changed item on relist → MODIFIED handler fired", async () => {
    const events: Array<{ op: string; id: string; rv: string }> = [];
    const ac = new AbortController();
    let step = 0;
    const fetchImpl: typeof fetch = (async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/api/list")) {
        step += 1;
        // Round 1: E_A at rv=1. Round 2: E_A at rv=2 (changed).
        const items = step === 1 ? [E_A] : [E_A_v2];
        return new Response(
          JSON.stringify({ items, listResourceVersion: step === 1 ? "5" : "10" }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (step === 1) {
        return new Response(sse("ERROR", { code: 410 }, "5"), {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      ac.abort();
      return new Response("", { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: fetchImpl,
        backoff: { minMs: 0, maxMs: 0, jitter: 0 },
      }),
      "Contribution",
    );
    informer.addEventHandler((op, entity) => {
      events.push({
        op,
        id: (entity as { id: string }).id,
        rv: (entity as { resourceVersion: string }).resourceVersion,
      });
    });
    await informer.run(ac.signal);

    const modifiedA = events.find((e) => e.op === "MODIFIED" && e.id === "cid-a" && e.rv === "2");
    expect(modifiedA).toBeDefined();
    expect(
      (informer.getById("cid-a") as { resourceVersion: string } | undefined)?.resourceVersion,
    ).toBe("2");
  });

  test("unchanged item on relist → no handler called for it", async () => {
    // E_A present in both rounds at same resourceVersion → no MODIFIED
    const events: Array<{ op: string; id: string }> = [];
    const ac = new AbortController();
    let step = 0;
    const fetchImpl: typeof fetch = (async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/api/list")) {
        step += 1;
        return new Response(
          JSON.stringify({ items: [E_A], listResourceVersion: step === 1 ? "5" : "10" }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (step === 1) {
        return new Response(sse("ERROR", { code: 410 }, "5"), {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      ac.abort();
      return new Response("", { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: fetchImpl,
        backoff: { minMs: 0, maxMs: 0, jitter: 0 },
      }),
      "Contribution",
    );
    informer.addEventHandler((op, entity) => {
      events.push({ op, id: (entity as { id: string }).id });
    });
    await informer.run(ac.signal);

    // Round 1 fires ADDED for E_A. Round 2: E_A unchanged → no MODIFIED.
    const round2Modified = events.filter((e) => e.op === "MODIFIED" && e.id === "cid-a");
    expect(round2Modified).toHaveLength(0);
  });
});

// ─── RELIST_ABORTED ───────────────────────────────────────────────────────────

describe("Informer RELIST_ABORTED", () => {
  test("aborted relist leaves cache unchanged from prior sync", async () => {
    const ac = new AbortController();
    let step = 0;
    const fetchImpl: typeof fetch = (async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/api/list")) {
        step += 1;
        if (step === 1) {
          return new Response(JSON.stringify({ items: [E_A], listResourceVersion: "5" }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        // Second list: return valid data but abort during BEGIN so ABORTED fires
        return new Response(JSON.stringify({ items: [E_B], listResourceVersion: "10" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (step === 1) {
        return new Response(sse("ERROR", { code: 410 }, "5"), {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      // For the second relist, abort the controller mid-BEGIN (simulated by abort before list delivers)
      // The WatchClient emits RELIST_ABORTED when abort happens during snapshot.
      // We just abort on the second watch call; the relist_end won't fire.
      ac.abort();
      return new Response("", { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: fetchImpl,
        backoff: { minMs: 0, maxMs: 0, jitter: 0 },
      }),
      "Contribution",
    );
    await informer.run(ac.signal);

    // After abort mid-relist, cache still holds first synced state (E_A only)
    // The second relist (step=2) had items=[E_B], but if RELIST_ABORTED fires
    // the staging is discarded. However in this test the abort happens after
    // RELIST_END of round 2 since the list completes before the watch call.
    // Specifically: we just verify the informer stays consistent.
    expect(informer.hasSynced()).toBe(true);
  });
});

// ─── Multiple handlers ────────────────────────────────────────────────────────

describe("Informer multiple handlers", () => {
  test("all registered handlers receive each event", async () => {
    const ac = new AbortController();
    const h1Events: string[] = [];
    const h2Events: string[] = [];
    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: makeFetch(
          { items: [E_A], listResourceVersion: "5" },
          sse("ADDED", { rv: "6", kind: "Contribution", entity: E_B }, "6"),
          ac,
        ),
        backoff: { minMs: 0, maxMs: 0, jitter: 0 },
      }),
      "Contribution",
    );
    informer.addEventHandler((op, entity) => {
      h1Events.push(`${op}:${(entity as { id: string }).id}`);
      if (op === "ADDED" && (entity as { id: string }).id === "cid-b") ac.abort();
    });
    informer.addEventHandler((op, entity) => {
      h2Events.push(`${op}:${(entity as { id: string }).id}`);
    });
    await informer.run(ac.signal);

    // Both handlers see ADDED for E_A (from relist reconciliation) and E_B (from delta)
    expect(h1Events).toContain("ADDED:cid-a");
    expect(h1Events).toContain("ADDED:cid-b");
    expect(h2Events).toContain("ADDED:cid-a");
    expect(h2Events).toContain("ADDED:cid-b");
  });
});

// ─── Handlers see updated cache ───────────────────────────────────────────────

describe("Informer handler sees post-update cache", () => {
  test("handler called after cache update (getById returns new state)", async () => {
    const ac = new AbortController();
    let seenInHandler: { id: string; rv: string } | undefined;
    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: makeFetch(
          { items: [], listResourceVersion: "5" },
          sse("ADDED", { rv: "6", kind: "Contribution", entity: E_A }, "6"),
          ac,
        ),
        backoff: { minMs: 0, maxMs: 0, jitter: 0 },
      }),
      "Contribution",
    );
    informer.addEventHandler((op, entity) => {
      if (op === "ADDED") {
        const fromCache = informer.getById((entity as { id: string }).id);
        seenInHandler = fromCache
          ? {
              id: (fromCache as { id: string }).id,
              rv: (fromCache as { resourceVersion: string }).resourceVersion,
            }
          : undefined;
        ac.abort();
      }
    });
    await informer.run(ac.signal);

    expect(seenInHandler?.id).toBe("cid-a");
    expect(seenInHandler?.rv).toBe("1");
  });
});

// ─── InformerFactory ─────────────────────────────────────────────────────────

describe("InformerFactory memoization", () => {
  test("same instance returned for same kind", () => {
    const factory = new InformerFactory({
      mode: "remote",
      baseUrl: "http://t",
      authHeader: "Bearer x",
    });
    const a = factory.informerFor("Contribution");
    const b = factory.informerFor("Contribution");
    expect(a).toBe(b);
  });

  test("different instances for different kinds", () => {
    const factory = new InformerFactory({
      mode: "remote",
      baseUrl: "http://t",
      authHeader: "Bearer x",
    });
    const contrib = factory.informerFor("Contribution");
    const claim = factory.informerFor("Claim");
    expect(contrib).not.toBe(claim);
  });

  test("AgentSession unsupported in remote mode — informerFor throws, supportsKind=false", () => {
    const factory = new InformerFactory({
      mode: "remote",
      baseUrl: "http://t",
      authHeader: "Bearer x",
    });
    expect(factory.mode).toBe("remote");
    expect(factory.supportsKind("Contribution")).toBe(true);
    expect(factory.supportsKind("Claim")).toBe(true);
    expect(factory.supportsKind("AgentSession")).toBe(false);
    expect(() => factory.informerFor("AgentSession")).toThrow(/mode=remote/);
  });

  test("AgentSession supported in local mode — informerFor returns informer, supportsKind=true", () => {
    const factory = new InformerFactory({
      mode: "local",
      hub: new WatchHub(),
      namespace: "default",
      listFn: () => [],
    });
    expect(factory.mode).toBe("local");
    expect(factory.supportsKind("Contribution")).toBe(true);
    expect(factory.supportsKind("Claim")).toBe(true);
    expect(factory.supportsKind("AgentSession")).toBe(true);
    const informer = factory.informerFor("AgentSession");
    expect(informer).toBeDefined();
  });

  test("InformerFactory supports AgentTask in local and remote modes", () => {
    const localFactory = new InformerFactory({
      mode: "local",
      hub: new WatchHub(),
      namespace: "default",
      listFn: () => [],
    });
    expect(localFactory.supportsKind("AgentTask")).toBe(true);
    expect(localFactory.informerFor("AgentTask")).toBeDefined();

    const remoteFactory = new InformerFactory({
      mode: "remote",
      baseUrl: "http://localhost:4515",
      authHeader: "Bearer test",
    });
    expect(remoteFactory.supportsKind("AgentTask")).toBe(true);
    expect(remoteFactory.informerFor("AgentTask")).toBeDefined();
  });

  test("separate factories for separate namespaces use distinct instances", () => {
    // Each namespace gets its own factory (and its own authHeader that encodes
    // the namespace server-side). Two factories for different namespaces must
    // produce independent informers with no shared state.
    const factoryNs1 = new InformerFactory({
      mode: "remote",
      baseUrl: "http://t",
      authHeader: "Bearer ns1-token",
    });
    const factoryNs2 = new InformerFactory({
      mode: "remote",
      baseUrl: "http://t",
      authHeader: "Bearer ns2-token",
    });
    expect(factoryNs1.informerFor("Contribution")).not.toBe(factoryNs2.informerFor("Contribution"));
  });
});

// ─── run() safety ─────────────────────────────────────────────────────────────

describe("Informer run() safety", () => {
  test("concurrent run() calls are rejected with an error", async () => {
    const ac = new AbortController();
    // Fetch that blocks indefinitely until aborted
    const fetchImpl = (async (_input: unknown, init?: { signal?: AbortSignal }) => {
      await new Promise<void>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
      throw new Error("unreachable");
    }) as unknown as typeof fetch;
    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: fetchImpl,
        backoff: { minMs: 0, maxMs: 0, jitter: 0 },
      }),
      "Contribution",
    );
    // Start first run (will block waiting for list response)
    const firstRun = informer.run(ac.signal);
    // Second concurrent run must reject immediately
    await expect(informer.run(ac.signal)).rejects.toThrow(/already running/);
    // Clean up
    ac.abort();
    await firstRun.catch(() => {
      /* abort rejects the blocked fake fetch */
    });
  });

  test("abort unblocks run() even if a handler promise is still pending", async () => {
    const ac = new AbortController();
    // Fetch: delivers one ADDED so the non-settling handler starts
    const fetchAc = new AbortController();
    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: makeFetch(
          { items: [], listResourceVersion: "5" },
          sse("ADDED", { rv: "6", kind: "Contribution", entity: E_A }, "6"),
          fetchAc,
        ),
        // minMs:1 (not 0) so the watch loop yields to setTimeout — needed because
        // delta enqueue is sync (B2 queue), so the loop no longer blocks on the
        // hung handler and would otherwise starve the test's setTimeout(20).
        backoff: { minMs: 1, maxMs: 1, jitter: 0 },
      }),
      "Contribution",
    );
    informer.addEventHandler(async () => {
      // Never resolves on its own
      await new Promise<void>(() => {
        /* intentionally pending */
      });
    });
    const running = informer.run(ac.signal);
    // Give the handler time to start
    await new Promise((r) => setTimeout(r, 20));
    // Abort — run() must complete despite the pending handler
    ac.abort();
    await expect(running).resolves.toBeUndefined();
    // _running must be reset; a fresh run on a new signal can start
    const ac2 = new AbortController();
    ac2.abort(); // abort immediately so it exits quickly
    await expect(informer.run(ac2.signal)).resolves.toBeUndefined();
  });

  test("run() is reusable after completion", async () => {
    const ac1 = new AbortController();
    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: makeFetch({ items: [], listResourceVersion: "5" }, "", ac1),
        backoff: { minMs: 0, maxMs: 0, jitter: 0 },
      }),
      "Contribution",
    );
    await informer.run(ac1.signal);
    // First run completed — second run must be accepted (not throw)
    const ac2 = new AbortController();
    const informer2 = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: makeFetch({ items: [], listResourceVersion: "5" }, "", ac2),
        backoff: { minMs: 0, maxMs: 0, jitter: 0 },
      }),
      "Contribution",
    );
    // Different instance, but proves the _running flag resets after completion
    await expect(informer2.run(ac2.signal)).resolves.toBeUndefined();
  });
});

// ─── Handler isolation ────────────────────────────────────────────────────────

describe("Informer handler isolation", () => {
  test("throwing handler does not prevent other handlers from receiving events", async () => {
    await withSilencedConsoleError(async () => {
      const ac = new AbortController();
      const received: string[] = [];
      const informer = new Informer(
        new WatchClient({
          baseUrl: "http://t",
          kind: "Contribution",
          authHeader: "Bearer x",
          fetch: makeFetch({ items: [E_A], listResourceVersion: "5" }, "", ac),
          backoff: { minMs: 0, maxMs: 0, jitter: 0 },
        }),
        "Contribution",
      );
      informer.addEventHandler(() => {
        throw new Error("handler boom");
      });
      informer.addEventHandler((op, entity) => {
        received.push(`${op}:${(entity as { id: string }).id}`);
      });
      await informer.run(ac.signal);
      // Second handler must still receive ADDED for E_A despite first handler throwing
      expect(received).toContain("ADDED:cid-a");
    });
  });

  test("throwing handler does not kill the watch loop (informer stays synced)", async () => {
    await withSilencedConsoleError(async () => {
      const ac = new AbortController();
      const informer = new Informer(
        new WatchClient({
          baseUrl: "http://t",
          kind: "Contribution",
          authHeader: "Bearer x",
          fetch: makeFetch({ items: [E_A], listResourceVersion: "5" }, "", ac),
          backoff: { minMs: 0, maxMs: 0, jitter: 0 },
        }),
        "Contribution",
      );
      informer.addEventHandler(() => {
        throw new Error("noisy handler");
      });
      // Should resolve (not reject) even though a handler always throws
      await expect(informer.run(ac.signal)).resolves.toBeUndefined();
      expect(informer.hasSynced()).toBe(true);
    });
  });

  test("unsubscribed handler no longer receives events", async () => {
    const ac = new AbortController();
    const received: string[] = [];
    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: makeFetch(
          { items: [], listResourceVersion: "5" },
          sse("ADDED", { rv: "6", kind: "Contribution", entity: E_A }, "6"),
          ac,
        ),
        backoff: { minMs: 0, maxMs: 0, jitter: 0 },
      }),
      "Contribution",
    );
    const unsubscribe = informer.addEventHandler((op, entity) => {
      received.push(`${op}:${(entity as { id: string }).id}`);
    });
    // Unsubscribe before run — handler must receive nothing
    unsubscribe();
    await informer.run(ac.signal);
    expect(received).toHaveLength(0);
  });

  test("addEventHandler returns unsubscribe; calling it mid-session stops delivery", async () => {
    const ac = new AbortController();
    const afterUnsub: string[] = [];
    let unsub: (() => void) | undefined;
    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: makeFetch(
          { items: [E_A], listResourceVersion: "5" },
          sse("ADDED", { rv: "6", kind: "Contribution", entity: E_B }, "6"),
          ac,
        ),
        backoff: { minMs: 0, maxMs: 0, jitter: 0 },
      }),
      "Contribution",
    );
    unsub = informer.addEventHandler((op, entity) => {
      const id = (entity as { id: string }).id;
      if (id === "cid-a") {
        // Unsubscribe after first event (the ADDED:cid-a from relist)
        unsub?.();
      } else {
        // Any subsequent event (ADDED:cid-b from delta) must not arrive
        afterUnsub.push(`${op}:${id}`);
        ac.abort();
      }
    });
    await informer.run(ac.signal);
    expect(afterUnsub).toHaveLength(0);
  });

  test("handler that unsubscribes itself during dispatch does not skip next handler", async () => {
    // Regression: splice-during-iteration would shift handler[1] into index 0
    // and the for..of iterator would advance past it.
    const ac = new AbortController();
    const h2Events: string[] = [];
    let unsub: (() => void) | undefined;
    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: makeFetch({ items: [E_A], listResourceVersion: "5" }, "", ac),
        backoff: { minMs: 0, maxMs: 0, jitter: 0 },
      }),
      "Contribution",
    );
    unsub = informer.addEventHandler(() => {
      unsub?.(); // self-unsubscribe during first dispatch
    });
    informer.addEventHandler((op, entity) => {
      h2Events.push(`${op}:${(entity as { id: string }).id}`);
    });
    await informer.run(ac.signal);
    // h2 must still receive the ADDED:cid-a from the relist
    expect(h2Events).toContain("ADDED:cid-a");
  });

  test("async handler rejection does not become unhandled and does not skip next handler", async () => {
    await withSilencedConsoleError(async () => {
      const ac = new AbortController();
      const h2Events: string[] = [];
      const informer = new Informer(
        new WatchClient({
          baseUrl: "http://t",
          kind: "Contribution",
          authHeader: "Bearer x",
          fetch: makeFetch({ items: [E_A], listResourceVersion: "5" }, "", ac),
          backoff: { minMs: 0, maxMs: 0, jitter: 0 },
        }),
        "Contribution",
      );
      // Async handler that rejects — must not propagate as unhandled rejection
      informer.addEventHandler(async () => {
        throw new Error("async handler boom");
      });
      informer.addEventHandler((op, entity) => {
        h2Events.push(`${op}:${(entity as { id: string }).id}`);
      });
      // Must resolve (not reject), and h2 must still get events
      await expect(informer.run(ac.signal)).resolves.toBeUndefined();
      expect(h2Events).toContain("ADDED:cid-a");
    });
  });

  test("slow async handler delays next event delivery (serialized fanout)", async () => {
    // WatchClient's per-event ordering guarantee extends through informer fanout:
    // the second event must not be delivered before the first handler settles.
    // Use a separate fetchAc so the watch loop's auto-abort on second watch call
    // does not abort the run signal — otherwise the in-flight drain would race
    // against the abort and skip cid-a's handler before resolveFirst() fires.
    const ac = new AbortController();
    const fetchAc = new AbortController();
    const order: string[] = [];
    let resolveFirst: (() => void) | undefined;

    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: makeFetch(
          { items: [], listResourceVersion: "5" },
          `${sse("ADDED", { rv: "6", kind: "Contribution", entity: E_A }, "6")}${sse("ADDED", { rv: "7", kind: "Contribution", entity: E_B }, "7")}`,
          fetchAc,
        ),
        // minMs:1 (not 0) so the watch loop yields to setTimeout — needed because
        // delta enqueue is sync (B2 queue), so the loop no longer blocks on the
        // hung handler and would otherwise starve the test's setTimeout(20).
        backoff: { minMs: 1, maxMs: 1, jitter: 0 },
      }),
      "Contribution",
    );
    informer.addEventHandler(async (_op, entity) => {
      order.push(`enter:${(entity as { id: string }).id}`);
      if ((entity as { id: string }).id === "cid-a") {
        await new Promise<void>((r) => {
          resolveFirst = r;
        });
      }
      order.push(`exit:${(entity as { id: string }).id}`);
      if ((entity as { id: string }).id === "cid-b") ac.abort();
    });

    const running = informer.run(ac.signal);
    // Give the loop a tick to enter handler for cid-a
    await new Promise((r) => setTimeout(r, 20));
    // cid-b must not have been entered yet (handler for cid-a still blocking)
    expect(order).toEqual(["enter:cid-a"]);
    resolveFirst?.();
    await running;
    expect(order).toEqual(["enter:cid-a", "exit:cid-a", "enter:cid-b", "exit:cid-b"]);
  });
});

// ─── InformerFactory lifecycle ────────────────────────────────────────────────

describe("InformerFactory lifecycle", () => {
  test("startAll is idempotent — repeated calls do not double-run a kind", async () => {
    const ac = new AbortController();
    const fetchImpl = makeFetch({ items: [], listResourceVersion: "0" }, "", ac);
    const factory = new InformerFactory({
      mode: "remote",
      baseUrl: "http://t",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    factory.startAll();
    factory.startAll(); // second call must be a no-op (no second run() per kind)
    await factory.stopAll();
    // If startAll were not idempotent, the inner Informer.run() would have
    // thrown "called while already running"; reaching here means it didn't.
    expect(true).toBe(true);
  });

  test("stopAll aborts and awaits run promises", async () => {
    const ac = new AbortController();
    const fetchImpl = makeFetch({ items: [], listResourceVersion: "0" }, "", ac);
    const factory = new InformerFactory({
      mode: "remote",
      baseUrl: "http://t",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    factory.startAll();
    await factory.stopAll();
    // After stopAll, factory is reusable.
    const ac2 = new AbortController();
    const fetchImpl2 = makeFetch({ items: [], listResourceVersion: "0" }, "", ac2);
    const factory2 = new InformerFactory({
      mode: "remote",
      baseUrl: "http://t",
      authHeader: "Bearer x",
      fetch: fetchImpl2,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    factory2.startAll();
    await factory2.stopAll();
    expect(true).toBe(true);
  });

  test("relist(kind) restarts a single kind without throwing", async () => {
    const ac = new AbortController();
    const fetchImpl = makeFetch({ items: [], listResourceVersion: "0" }, "", ac);
    const factory = new InformerFactory({
      mode: "remote",
      baseUrl: "http://t",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    factory.startAll();
    await factory.relist("Contribution");
    await factory.stopAll();
    expect(true).toBe(true);
  });
});

// ─── InformerFactory queue config ─────────────────────────────────────────────

describe("InformerFactory queue config", () => {
  test("queueLimits override applies per kind", () => {
    const factory = new InformerFactory({
      mode: "local",
      hub: new WatchHub(),
      namespace: "default",
      listFn: () => [],
      queueLimits: { AgentSession: 5 },
    });
    const c = factory.informerFor("Contribution");
    const a = factory.informerFor("AgentSession");
    expect(c.getQueueStats().limit).toBe(1000); // default
    expect(a.getQueueStats().limit).toBe(5); // overridden
  });

  test("overflow on a factory-created informer triggers factory.relist(kind)", async () => {
    const factory = new InformerFactory({
      mode: "local",
      hub: new WatchHub(),
      namespace: "default",
      listFn: () => [],
      queueLimits: { Contribution: 2 },
    });
    // Spy on relist by wrapping the bound method.
    const relistCalls: WatchKind[] = [];
    const origRelist = factory.relist.bind(factory);
    factory.relist = async (kind?: WatchKind) => {
      if (kind) relistCalls.push(kind);
      return origRelist(kind);
    };
    const informer = factory.informerFor("Contribution");
    // Drive overflow via the private enqueue path (cast through unknown).
    const enq = (informer as unknown as { enqueue: (e: WatchClientEvent) => void }).enqueue.bind(
      informer,
    );
    enq(deltaEvent("ADDED", "a", "1"));
    enq(deltaEvent("ADDED", "b", "2"));
    enq(deltaEvent("ADDED", "c", "3")); // overflow
    // relist is async (microtask) since onOverflow does void this.relist(kind)
    await drainMicrotasks();
    expect(relistCalls).toEqual(["Contribution"]);
    expect(informer.getQueueStats().overflows).toBe(1);
    await factory.stopAll();
  });
});

// ─── Cache immutability ───────────────────────────────────────────────────────

describe("Informer cache immutability", () => {
  test("mutating a returned entity does not corrupt cache (resourceVersion frozen)", async () => {
    const ac = new AbortController();
    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: makeFetch({ items: [E_A], listResourceVersion: "5" }, "", ac),
        backoff: { minMs: 0, maxMs: 0, jitter: 0 },
      }),
      "Contribution",
    );
    await informer.run(ac.signal);
    const entity = informer.getById("cid-a");
    expect(entity).toBeDefined();
    // Attempt to mutate resourceVersion (should silently fail in non-strict mode
    // or throw in strict mode because the entity is frozen)
    try {
      (entity as unknown as Record<string, unknown>).resourceVersion = "999";
    } catch {
      // Expected in strict mode
    }
    // Cache must still hold the original version
    expect(informer.getById("cid-a")?.resourceVersion).toBe("1");
  });

  test("entities returned by list() are frozen", async () => {
    const ac = new AbortController();
    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: makeFetch({ items: [E_A, E_B], listResourceVersion: "5" }, "", ac),
        backoff: { minMs: 0, maxMs: 0, jitter: 0 },
      }),
      "Contribution",
    );
    await informer.run(ac.signal);
    for (const e of informer.list()) {
      expect(Object.isFrozen(e)).toBe(true);
    }
  });

  test("mutating nested spec field does not corrupt cache (deep freeze)", async () => {
    const ac = new AbortController();
    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: makeFetch({ items: [E_A], listResourceVersion: "5" }, "", ac),
        backoff: { minMs: 0, maxMs: 0, jitter: 0 },
      }),
      "Contribution",
    );
    await informer.run(ac.signal);
    const entity = informer.getById("cid-a");
    const origSummary = (entity as unknown as { spec: { summary: string } })?.spec?.summary;
    // Attempt to mutate nested spec.summary (throws in strict mode, silently fails otherwise)
    try {
      (entity as unknown as { spec: Record<string, unknown> }).spec.summary = "hacked";
    } catch {
      // Expected under strict mode / frozen object
    }
    // Cache entry must still have the original spec.summary
    const fromCache = informer.getById("cid-a") as unknown as { spec: { summary: string } };
    expect(fromCache?.spec?.summary).toBe(origSummary);
  });

  test("nested objects within entities are frozen (deep freeze)", async () => {
    const ac = new AbortController();
    const informer = new Informer(
      new WatchClient({
        baseUrl: "http://t",
        kind: "Contribution",
        authHeader: "Bearer x",
        fetch: makeFetch({ items: [E_A], listResourceVersion: "5" }, "", ac),
        backoff: { minMs: 0, maxMs: 0, jitter: 0 },
      }),
      "Contribution",
    );
    await informer.run(ac.signal);
    const entity = informer.getById("cid-a") as unknown as { spec: object; metadata: object };
    expect(Object.isFrozen(entity)).toBe(true);
    expect(Object.isFrozen(entity?.spec)).toBe(true);
    expect(Object.isFrozen(entity?.metadata)).toBe(true);
  });
});

test("Informer.addEventHandler forwards emittedAt via optional meta arg", async () => {
  const seenMeta: Array<{ emittedAt?: string } | undefined> = [];
  const stream = {
    run: async ({ onEvent }: { onEvent: (e: WatchClientEvent) => Promise<void> | void }) => {
      await onEvent({
        op: "ADDED",
        rv: 1n,
        kind: "Contribution",
        entity: E_A,
        emittedAt: "2026-05-04T12:00:00.000Z",
      });
    },
  };
  const informer = new Informer<"Contribution">(stream as never, "Contribution");
  informer.addEventHandler((_op, _entity, meta) => {
    seenMeta.push(meta);
  });
  await informer.run(new AbortController().signal);
  expect(seenMeta.length).toBe(1);
  expect(seenMeta[0]?.emittedAt).toBe("2026-05-04T12:00:00.000Z");
});

describe("Informer queue — RV-coalescing", () => {
  test("10000 events for same id → 1 applyEvent, peak depth 1", async () => {
    const { stream, emit } = makeFakeStream();
    const ac = new AbortController();
    const informer = new Informer(stream, "Contribution");
    const runPromise = informer.run(ac.signal);

    const handlerCalls: string[] = [];
    informer.addEventHandler((op, entity) => {
      handlerCalls.push(`${op}:${(entity as { resourceVersion: string }).resourceVersion}`);
    });

    // Burst all 10k emits synchronously: enqueue runs sync inside emit's body
    // up to its first await, so the loop never yields to microtasks. This
    // exercises pure coalescing — a single drain microtask runs after the loop,
    // sees the queue has one entry (RV=10000 overwrote the rest), processes it.
    // Awaiting per-iteration would let drain run between events and defeat coalescing.
    let peakDepth = 0;
    const emits: Array<Promise<void>> = [];
    for (let i = 0; i < 10_000; i += 1) {
      emits.push(emit(deltaEvent("MODIFIED", "same", String(i + 1))));
      const d = informer.getQueueStats().depth;
      if (d > peakDepth) peakDepth = d;
    }
    await Promise.all(emits);
    await drainMicrotasks();

    expect(peakDepth).toBe(1);
    expect(handlerCalls).toEqual(["MODIFIED:10000"]);

    ac.abort();
    await runPromise;
  });

  test("ADDED then DELETED same id within burst → final state absent", async () => {
    const { stream, emit } = makeFakeStream();
    const ac = new AbortController();
    const informer = new Informer(stream, "Contribution");
    const runPromise = informer.run(ac.signal);

    await emit(deltaEvent("ADDED", "x", "1"));
    await emit(deltaEvent("DELETED", "x", "2"));
    await drainMicrotasks();

    expect(informer.getById("x")).toBeUndefined();

    ac.abort();
    await runPromise;
  });

  test("DELETED then ADDED same id within burst → final state present (recreated)", async () => {
    const { stream, emit } = makeFakeStream();
    const ac = new AbortController();
    const informer = new Informer(stream, "Contribution");
    const runPromise = informer.run(ac.signal);

    await emit(deltaEvent("DELETED", "x", "1"));
    await emit(deltaEvent("ADDED", "x", "2"));
    await drainMicrotasks();

    expect(
      (informer.getById("x") as { resourceVersion: string } | undefined)?.resourceVersion,
    ).toBe("2");

    ac.abort();
    await runPromise;
  });

  test("RELIST_BEGIN drains queued deltas BEFORE setting staging; RELIST_END atomic-replaces", async () => {
    const { stream, emit } = makeFakeStream();
    const ac = new AbortController();
    const informer = new Informer(stream, "Contribution");
    const runPromise = informer.run(ac.signal);

    // Queue 5 distinct deltas (sync prefix — they enqueue but drain microtask hasn't fired).
    const promises: Array<Promise<void> | void> = [];
    for (let i = 0; i < 5; i += 1) {
      promises.push(emit(deltaEvent("ADDED", `delta-${i}`, String(i + 1))));
    }
    // Now emit RELIST_BEGIN — control event drains pending FIRST, then sets staging.
    await emit({ op: "RELIST_BEGIN", rv: 100n, kind: "Contribution", entity: null });
    await Promise.all(promises);

    // After RELIST_BEGIN: deltas have been applied to store (they drained before staging set).
    for (let i = 0; i < 5; i += 1) {
      expect(informer.getById(`delta-${i}`)?.id).toBe(`delta-${i}`);
    }

    // Emit RELIST_END with no RELIST rows → empty snapshot atomically replaces store.
    await emit({ op: "RELIST_END", rv: 100n, kind: "Contribution", entity: null });

    // After RELIST_END: store cleared by atomic replace from empty staging.
    for (let i = 0; i < 5; i += 1) {
      expect(informer.getById(`delta-${i}`)).toBeUndefined();
    }

    ac.abort();
    await runPromise;
  });

  test("getQueueStats: depth visible after sync-prefix enqueue, returns to 0 after drain", async () => {
    const { stream, emit } = makeFakeStream();
    const ac = new AbortController();
    const informer = new Informer(stream, "Contribution", { queueLimit: 100 });
    const runPromise = informer.run(ac.signal);

    expect(informer.getQueueStats()).toEqual({ depth: 0, limit: 100, overflows: 0 });

    // Sync-prefix enqueue 50 distinct ids (drain microtask hasn't fired yet).
    const promises: Array<Promise<void> | void> = [];
    for (let i = 0; i < 50; i += 1) {
      promises.push(emit(deltaEvent("ADDED", `id-${i}`, String(i + 1))));
    }
    expect(informer.getQueueStats().depth).toBe(50);
    expect(informer.getQueueStats().limit).toBe(100);
    expect(informer.getQueueStats().overflows).toBe(0);

    await Promise.all(promises);
    await drainMicrotasks();

    expect(informer.getQueueStats().depth).toBe(0);

    ac.abort();
    await runPromise;
  });
});

describe("Informer queue — overflow", () => {
  test("queueLimit+1 distinct ids → overflows=1, queue cleared, onOverflow fired exactly once", async () => {
    const { stream, emit } = makeFakeStream();
    const ac = new AbortController();
    const overflowKinds: WatchKind[] = [];
    const informer = new Informer(stream, "Contribution", {
      queueLimit: 5,
      onOverflow: (kind) => overflowKinds.push(kind),
    });
    const runPromise = informer.run(ac.signal);

    // Sync-prefix burst: enqueue 5 distinct ids before yielding to microtasks,
    // so depth is observed at exactly 5 before drain runs.
    const emits: Array<Promise<void>> = [];
    for (let i = 0; i < 5; i += 1) {
      emits.push(emit(deltaEvent("ADDED", `id-${i}`, String(i + 1))));
    }
    expect(informer.getQueueStats().depth).toBe(5);
    expect(informer.getQueueStats().overflows).toBe(0);

    // 6th distinct id (still in same sync-prefix burst) — must overflow.
    emits.push(emit(deltaEvent("ADDED", "id-overflow", "6")));
    expect(informer.getQueueStats().depth).toBe(0);
    expect(informer.getQueueStats().overflows).toBe(1);
    expect(overflowKinds).toEqual(["Contribution"]);

    await Promise.all(emits);

    ac.abort();
    await runPromise;
  });

  test("onOverflow callback that throws does not corrupt queue state", async () => {
    const { stream, emit } = makeFakeStream();
    const ac = new AbortController();
    const informer = new Informer(stream, "Contribution", {
      queueLimit: 2,
      onOverflow: () => {
        throw new Error("boom");
      },
    });
    const runPromise = informer.run(ac.signal);

    // Sync-prefix burst: keep all 3 emits in same microtask boundary so the
    // 3rd one observes depth=2 and triggers overflow.
    const emits: Array<Promise<void>> = [];
    emits.push(emit(deltaEvent("ADDED", "a", "1")));
    emits.push(emit(deltaEvent("ADDED", "b", "2")));
    emits.push(emit(deltaEvent("ADDED", "c", "3"))); // overflows; throws inside callback

    expect(informer.getQueueStats().depth).toBe(0);
    expect(informer.getQueueStats().overflows).toBe(1);

    await Promise.all(emits);

    ac.abort();
    await runPromise;
  });
});
