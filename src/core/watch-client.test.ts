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
  test("emits RELIST for each list item then ADDED for streamed events", async () => {
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
        if (seen.length === 2) ac.abort();
      },
      signal: ac.signal,
    });
    await running;

    expect(seen.length).toBe(2);
    expect(seen[0]?.op).toBe("RELIST");
    expect(seen[0]?.rv).toBe(5n);
    expect((seen[0]?.entity as { envelope: { id: string } }).envelope.id).toBe("cid-a");
    expect(seen[1]?.op).toBe("ADDED");
    expect(seen[1]?.rv).toBe(6n);
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
