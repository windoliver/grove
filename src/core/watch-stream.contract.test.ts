import { describe, expect, test } from "bun:test";
import { LocalWatchClient } from "./local-watch-client.js";
import type { WatchClientEvent } from "./watch-client.js";
import { WatchClient } from "./watch-client.js";
import type { WatchEntity, WatchKind } from "./watch-events.js";
import { WatchHub } from "./watch-hub.js";
import type { WatchStream } from "./watch-stream.js";

const NS = "default";
const KIND: WatchKind = "Contribution";

function mkEntity(id: string, rv: string): WatchEntity {
  return {
    kind: "Contribution",
    namespace: NS,
    id,
    spec: {
      contributionKind: "code",
      mode: "direct",
      summary: id,
      artifacts: {},
      relations: [],
      tags: [],
    },
    status: {},
    conditions: [],
    observedGeneration: 0,
    resourceVersion: rv,
    metadata: { generation: 1 },
  } as unknown as WatchEntity;
}

interface Backend {
  readonly name: string;
  readonly stream: WatchStream;
  readonly publishLive: (entity: WatchEntity) => void;
}

function localBackend(snapshot: readonly WatchEntity[]): Backend {
  const hub = new WatchHub();
  const stream = new LocalWatchClient({
    hub,
    kind: KIND,
    namespace: NS,
    listFn: () => snapshot,
  });
  return {
    name: "LocalWatchClient",
    stream,
    publishLive: (entity) => {
      hub.recordWrite({ op: "ADDED", kind: KIND, namespace: NS, entity });
    },
  };
}

function sse(event: string, data: unknown, id?: string): string {
  const idLine = id ? `id: ${id}\n` : "";
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function remoteBackend(snapshot: readonly WatchEntity[], live: readonly WatchEntity[]): Backend {
  const list = { items: [...snapshot], listResourceVersion: "0" };
  let body = "";
  let rv = 1n;
  for (const e of live) {
    body += sse("ADDED", { rv: String(rv), op: "ADDED", kind: KIND, entity: e }, String(rv));
    rv += 1n;
  }
  const ac = new AbortController();
  let watchCalls = 0;
  const fetchImpl = (async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("/api/list")) {
      return new Response(JSON.stringify(list), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/watch")) {
      watchCalls += 1;
      if (watchCalls === 1) {
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      ac.abort();
      return new Response("", { headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  const stream = new WatchClient({
    baseUrl: "http://t",
    kind: KIND,
    authHeader: "Bearer x",
    fetch: fetchImpl,
    backoff: { minMs: 0, maxMs: 0, jitter: 0 },
  });
  return {
    name: "WatchClient (remote, fake fetch)",
    stream,
    publishLive: () => {
      throw new Error("remote backend's live events are pre-baked into the SSE body");
    },
  };
}

describe("WatchStream contract", () => {
  for (const make of [
    () => localBackend([mkEntity("a", "1"), mkEntity("b", "1")]),
    () => remoteBackend([mkEntity("a", "1"), mkEntity("b", "1")], []),
  ]) {
    const backend = make();

    test(`${backend.name}: snapshot order = BEGIN, RELIST*, END`, async () => {
      const events: WatchClientEvent[] = [];
      const ac = new AbortController();
      const runPromise = backend.stream.run({
        onEvent: (e) => {
          events.push(e);
          if (e.op === "RELIST_END") ac.abort();
        },
        signal: ac.signal,
      });
      await runPromise.catch(() => undefined);

      expect(events.map((e) => e.op)).toEqual(["RELIST_BEGIN", "RELIST", "RELIST", "RELIST_END"]);
      expect(events[0]?.entity).toBeNull();
      expect(events[3]?.entity).toBeNull();
    });
  }

  test("LocalWatchClient: live ADDED arrives after RELIST_END", async () => {
    const backend = localBackend([]);
    const events: WatchClientEvent[] = [];
    const ac = new AbortController();
    const run = backend.stream.run({
      onEvent: (e) => {
        events.push(e);
        if (e.op === "ADDED") ac.abort();
      },
      signal: ac.signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    backend.publishLive(mkEntity("live-a", "1"));
    await run;
    expect(events.map((e) => e.op)).toEqual(["RELIST_BEGIN", "RELIST_END", "ADDED"]);
  });
});
