import { afterEach, describe, expect, test } from "bun:test";

import { NexusConflictError } from "./errors.js";
import { NexusHttpClient } from "./nexus-http-client.js";

describe("NexusHttpClient", () => {
  const servers: { stop(force?: boolean): void }[] = [];

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.stop(true);
    }
  });

  test.each([
    409, 412,
  ])("maps HTTP %i write preconditions to NexusConflictError", async (status) => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("etag mismatch", {
          status,
          headers: { etag: "actual-etag" },
        });
      },
    });
    servers.push(server);

    const client = new NexusHttpClient({ url: `http://127.0.0.1:${server.port}` });

    let caught: unknown;
    try {
      await client.write("/conflict", new TextEncoder().encode("payload"), { ifNoneMatch: "*" });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(NexusConflictError);
    expect(caught).toMatchObject({ actualEtag: "actual-etag" });
  });
});
