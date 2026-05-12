import { afterEach, describe, expect, test } from "bun:test";

import { NexusConflictError } from "./errors.js";
import { NexusHttpClient } from "./nexus-http-client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function parseRequestBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error("Expected JSON request body");
  }
  return JSON.parse(body) as unknown;
}

function setMockFetch(
  impl: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = impl as unknown as typeof fetch;
}

describe("NexusHttpClient", () => {
  test("serializes ifNoneMatch create-only writes as REST boolean", async () => {
    const bodies: unknown[] = [];
    setMockFetch(async (_input, init) => {
      bodies.push(parseRequestBody(init));
      return new Response(
        JSON.stringify({
          content_id: "etag-1",
          version: 1,
          size: 4,
        }),
        { status: 200 },
      );
    });

    const client = new NexusHttpClient({ url: "http://nexus.local" });
    await client.write("/path/file", new TextEncoder().encode("data"), { ifNoneMatch: "*" });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ if_none_match: true });
  });

  test("maps REST precondition failures to NexusConflictError", async () => {
    setMockFetch(async () => new Response("already exists", { status: 412 }));

    const client = new NexusHttpClient({ url: "http://nexus.local" });

    await expect(
      client.write("/path/file", new TextEncoder().encode("data"), { ifNoneMatch: "*" }),
    ).rejects.toThrow(NexusConflictError);
  });

  test("writeBatch posts wrapped bytes to the REST batch endpoint", async () => {
    const bodies: unknown[] = [];
    const urls: string[] = [];
    setMockFetch(async (input, init) => {
      urls.push(String(input));
      bodies.push(parseRequestBody(init));
      return new Response(
        JSON.stringify({
          results: [
            {
              path: "/path/file",
              content_id: "etag-1",
              version: 2,
              size: 4,
              modified_at: "2026-05-11T00:00:00Z",
            },
          ],
        }),
        { status: 200 },
      );
    });

    const client = new NexusHttpClient({ url: "http://nexus.local" });
    const results = await client.writeBatch([{ path: "/path/file", content: new Uint8Array([1]) }]);

    expect(urls).toEqual(["http://nexus.local/api/v2/files/batch/write"]);
    expect(bodies).toEqual([
      {
        files: [
          {
            path: "/path/file",
            content_base64: Buffer.from("AQ==").toString("base64"),
          },
        ],
      },
    ]);
    expect(results).toEqual([{ bytesWritten: 4, etag: "etag-1", version: 2 }]);
  });
});
