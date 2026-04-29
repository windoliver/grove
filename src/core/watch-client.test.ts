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
