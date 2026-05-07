import { afterEach, describe, expect, test } from "bun:test";

import { NexusHttpClient } from "../../../src/nexus/nexus-http-client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("NexusHttpClient", () => {
  test('serializes ifNoneMatch="*" as Nexus REST create-only boolean', async () => {
    let capturedBody: unknown;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          content_id: "etag-1",
          version: 1,
          size: 4,
          modified_at: "2026-05-06T00:00:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const client = new NexusHttpClient({ url: "http://nexus.test" });
    await client.write("/work/item.json", new TextEncoder().encode("data"), {
      ifNoneMatch: "*",
    });

    expect(capturedBody).toMatchObject({ if_none_match: true });
  });
});
