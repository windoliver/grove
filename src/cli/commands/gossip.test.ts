/**
 * Tests for grove gossip commands.
 *
 * Uses real Bun.serve() for peer/server simulation and real SQLite
 * stores for direct gossip commands.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultFrontierCalculator } from "../../core/frontier.js";
import { ScoreDirection } from "../../core/models.js";
import { makeContribution } from "../../core/test-helpers.js";
import { FsCas } from "../../local/fs-cas.js";
import { SqliteGossipStore } from "../../local/gossip-store.js";
import { initSqliteDb, SqliteContributionStore } from "../../local/sqlite-store.js";
import type { CliDeps } from "../context.js";
import { handleGossip } from "./gossip.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let deps: CliDeps;
let mockServer: ReturnType<typeof Bun.serve>;
let serverUrl: string;

function createOutput(): { lines: string[]; writer: (s: string) => void } {
  const lines: string[] = [];
  return { lines, writer: (s: string) => lines.push(s) };
}

function withCliDepsTest(
  fn: (args: readonly string[], deps: CliDeps) => Promise<void>,
  args: readonly string[],
): Promise<void> {
  return fn(args, deps);
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "grove-gossip-cli-test-"));
  // Create .grove directory structure so resolveGroveDir can find it
  const groveDir = join(tmpDir, ".grove");
  await mkdir(groveDir, { recursive: true });
  const db = initSqliteDb(join(groveDir, "grove.db"));
  const store = new SqliteContributionStore(db);
  const cas = new FsCas(join(groveDir, "cas"));
  const frontier = new DefaultFrontierCalculator(store);
  deps = {
    store,
    frontier,
    workspace: undefined as never,
    cas,
    groveRoot: tmpDir,
    close: () => {
      store.close();
    },
  };
});

afterEach(async () => {
  deps.close();
  if (mockServer) mockServer.stop(true);
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Help / usage
// ---------------------------------------------------------------------------

describe("gossip help", () => {
  test("shows usage when no subcommand", async () => {
    const { lines, writer } = createOutput();
    await handleGossip([], undefined, undefined, writer);
    expect(lines.join("\n")).toContain("grove gossip");
    expect(lines.join("\n")).toContain("exchange");
    expect(lines.join("\n")).toContain("shuffle");
  });

  test("shows usage for --help", async () => {
    const { lines, writer } = createOutput();
    await handleGossip(["--help"], undefined, undefined, writer);
    expect(lines.join("\n")).toContain("grove gossip");
  });

  test("sets exit code for unknown subcommand", async () => {
    const { writer } = createOutput();
    await handleGossip(["unknown"], undefined, undefined, writer);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

// ---------------------------------------------------------------------------
// Server query: peers
// ---------------------------------------------------------------------------

describe("gossip peers", () => {
  test("displays peers from server", async () => {
    mockServer = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/api/gossip/peers") {
          return Response.json({
            peers: [
              {
                peerId: "peer-1",
                address: "http://host1:4515",
                age: 3,
                lastSeen: "2025-01-01T00:00:00Z",
              },
            ],
            liveness: [
              {
                peer: {
                  peerId: "peer-1",
                  address: "http://host1:4515",
                  age: 3,
                  lastSeen: "2025-01-01T00:00:00Z",
                },
                status: "alive",
                lastSeen: "2025-01-01T00:00:00Z",
              },
            ],
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    serverUrl = `http://localhost:${mockServer.port}`;

    const { lines, writer } = createOutput();
    await handleGossip(["peers", "--server", serverUrl], undefined, undefined, writer);

    const text = lines.join("\n");
    expect(text).toContain("peer-1");
    expect(text).toContain("http://host1:4515");
    expect(text).toContain("[alive]");
    expect(text).toContain("1 peer(s)");
  });

  test("displays no peers message", async () => {
    mockServer = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ peers: [], liveness: [] });
      },
    });
    serverUrl = `http://localhost:${mockServer.port}`;

    const { lines, writer } = createOutput();
    await handleGossip(["peers", "--server", serverUrl], undefined, undefined, writer);
    expect(lines.join("\n")).toContain("No peers known");
  });

  test("outputs JSON when requested", async () => {
    mockServer = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          peers: [{ peerId: "p1", address: "http://h:1", age: 0, lastSeen: "" }],
          liveness: [],
        });
      },
    });
    serverUrl = `http://localhost:${mockServer.port}`;

    const { lines, writer } = createOutput();
    await handleGossip(["peers", "--server", serverUrl, "--json"], undefined, undefined, writer);

    const parsed = JSON.parse(lines.join(""));
    expect(parsed.peers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Server query: status
// ---------------------------------------------------------------------------

describe("gossip status", () => {
  test("shows enabled status", async () => {
    mockServer = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          version: "0.1.0",
          stats: { contributions: 5, activeClaims: 2 },
          gossip: {
            enabled: true,
            peers: 3,
            liveness: [
              { peerId: "p1", status: "alive", lastSeen: "2025-01-01T00:00:00Z" },
              { peerId: "p2", status: "suspected", lastSeen: "2025-01-01T00:00:00Z" },
            ],
          },
        });
      },
    });
    serverUrl = `http://localhost:${mockServer.port}`;

    const { lines, writer } = createOutput();
    await handleGossip(["status", "--server", serverUrl], undefined, undefined, writer);

    const text = lines.join("\n");
    expect(text).toContain("Gossip: enabled");
    expect(text).toContain("Peers: 3");
    expect(text).toContain("Contributions: 5");
    expect(text).toContain("p1");
    expect(text).toContain("[SUSPECTED]");
  });

  test("shows disabled status", async () => {
    mockServer = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          version: "0.1.0",
          stats: { contributions: 0, activeClaims: 0 },
          gossip: { enabled: false },
        });
      },
    });
    serverUrl = `http://localhost:${mockServer.port}`;

    const { lines, writer } = createOutput();
    await handleGossip(["status", "--server", serverUrl], undefined, undefined, writer);
    expect(lines.join("\n")).toContain("Gossip: disabled");
  });
});

// ---------------------------------------------------------------------------
// Server query: frontier
// ---------------------------------------------------------------------------

describe("gossip frontier", () => {
  test("displays frontier entries grouped by metric", async () => {
    mockServer = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          entries: [
            { metric: "val_bpb", value: 0.85, cid: "blake3:aabb" },
            { metric: "val_bpb", value: 0.9, cid: "blake3:ccdd" },
            { metric: "_adoption", value: 12, cid: "blake3:eeff" },
          ],
        });
      },
    });
    serverUrl = `http://localhost:${mockServer.port}`;

    const { lines, writer } = createOutput();
    await handleGossip(["frontier", "--server", serverUrl], undefined, undefined, writer);

    const text = lines.join("\n");
    expect(text).toContain("val_bpb:");
    expect(text).toContain("_adoption:");
    expect(text).toContain("value=0.85");
  });

  test("shows empty frontier message", async () => {
    mockServer = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ entries: [] });
      },
    });
    serverUrl = `http://localhost:${mockServer.port}`;

    const { lines, writer } = createOutput();
    await handleGossip(["frontier", "--server", serverUrl], undefined, undefined, writer);
    expect(lines.join("\n")).toContain("no frontier data");
  });
});

// ---------------------------------------------------------------------------
// Direct: exchange
// ---------------------------------------------------------------------------

describe("gossip exchange", () => {
  test("performs push-pull exchange with a peer", async () => {
    // Add a contribution to local store
    const c = makeContribution({
      summary: "local work",
      scores: { acc: { value: 0.95, direction: ScoreDirection.Maximize } },
    });
    await deps.store.put(c);

    // Mock peer server
    mockServer = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname === "/api/gossip/exchange") {
          // Echo back a response with a different CID
          return Response.json({
            peerId: "remote-peer",
            frontier: [
              {
                metric: "acc",
                value: 0.97,
                cid: "blake3:remote1111111111111111111111111111111111111111111111111111111111",
              },
            ],
            load: { queueDepth: 1 },
            capabilities: {},
            timestamp: new Date().toISOString(),
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    serverUrl = `http://localhost:${mockServer.port}`;

    const { lines, writer } = createOutput();
    await handleGossip(
      ["exchange", serverUrl, "--peer-id", "test-cli"],
      undefined,
      withCliDepsTest,
      writer,
    );

    const text = lines.join("\n");
    expect(text).toContain("Exchanging frontier");
    expect(text).toContain("remote-peer");
    expect(text).toContain("Frontier entries: 1");
    expect(text).toContain("New CIDs discovered: 1");
  });

  test("reports when frontiers are in sync", async () => {
    mockServer = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          peerId: "remote",
          frontier: [],
          load: { queueDepth: 0 },
          capabilities: {},
          timestamp: new Date().toISOString(),
        });
      },
    });
    serverUrl = `http://localhost:${mockServer.port}`;

    const { lines, writer } = createOutput();
    await handleGossip(["exchange", serverUrl], undefined, withCliDepsTest, writer);

    expect(lines.join("\n")).toContain("in sync");
  });

  test("throws without peer URL", async () => {
    const { writer } = createOutput();
    await expect(handleGossip(["exchange"], undefined, withCliDepsTest, writer)).rejects.toThrow(
      "peer-url",
    );
  });
});

// ---------------------------------------------------------------------------
// Direct: shuffle
// ---------------------------------------------------------------------------

describe("gossip shuffle", () => {
  test("performs CYCLON shuffle with a peer", async () => {
    mockServer = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname === "/api/gossip/shuffle") {
          return Response.json({
            offered: [
              {
                peerId: "discovered-1",
                address: "http://d1:4515",
                age: 1,
                lastSeen: "2025-01-01T00:00:00Z",
              },
              {
                peerId: "discovered-2",
                address: "http://d2:4515",
                age: 2,
                lastSeen: "2025-01-01T00:00:00Z",
              },
            ],
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    serverUrl = `http://localhost:${mockServer.port}`;

    const { lines, writer } = createOutput();
    await handleGossip(
      ["shuffle", serverUrl, "--peer-id", "cli-test"],
      undefined,
      undefined,
      writer,
    );

    const text = lines.join("\n");
    expect(text).toContain("Shuffling with");
    expect(text).toContain("Discovered 2 peer(s)");
    expect(text).toContain("discovered-1");
    expect(text).toContain("discovered-2");
  });

  test("handles peer with no peers to share", async () => {
    mockServer = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ offered: [] });
      },
    });
    serverUrl = `http://localhost:${mockServer.port}`;

    const { lines, writer } = createOutput();
    await handleGossip(
      ["shuffle", `http://localhost:${mockServer.port}`],
      undefined,
      undefined,
      writer,
    );

    expect(lines.join("\n")).toContain("no other peers");
  });
});

// ---------------------------------------------------------------------------
// Direct: sync
// ---------------------------------------------------------------------------

describe("gossip sync", () => {
  test("performs full round: shuffle + exchange with seeds", async () => {
    // Add a contribution to local store
    const c = makeContribution({
      summary: "sync test",
      scores: { metric1: { value: 1.0, direction: ScoreDirection.Maximize } },
    });
    await deps.store.put(c);

    mockServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/api/gossip/shuffle") {
          return Response.json({
            offered: [
              {
                peerId: "extra-peer",
                address: `http://localhost:${mockServer.port}`,
                age: 0,
                lastSeen: new Date().toISOString(),
              },
            ],
          });
        }
        if (path === "/api/gossip/exchange") {
          return Response.json({
            peerId: "seed-peer",
            frontier: [
              {
                metric: "metric1",
                value: 2.0,
                cid: "blake3:newcid11111111111111111111111111111111111111111111111111111111",
              },
            ],
            load: { queueDepth: 0 },
            capabilities: {},
            timestamp: new Date().toISOString(),
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    serverUrl = `http://localhost:${mockServer.port}`;

    const { lines, writer } = createOutput();
    await handleGossip(
      ["sync", `seed@${serverUrl}`, "--peer-id", "sync-cli"],
      undefined,
      withCliDepsTest,
      writer,
    );

    const text = lines.join("\n");
    expect(text).toContain("Syncing with 1 seed(s)");
    expect(text).toContain("Discovered");
    expect(text).toContain("Sync complete");
    expect(text).toContain("New CIDs discovered");
  });

  test("throws without seeds argument", async () => {
    const { writer } = createOutput();
    await expect(handleGossip(["sync"], undefined, withCliDepsTest, writer)).rejects.toThrow(
      "Usage",
    );
  });

  test("handles seed connection failure gracefully", async () => {
    const { lines, writer } = createOutput();
    await handleGossip(
      ["sync", "bad-seed@http://localhost:1", "--peer-id", "fail-test"],
      undefined,
      withCliDepsTest,
      writer,
    );

    const text = lines.join("\n");
    expect(text).toContain("Failed:");
    expect(text).toContain("Sync complete");
  });

  test("outputs JSON when requested", async () => {
    mockServer = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/api/gossip/shuffle") return Response.json({ offered: [] });
        if (path === "/api/gossip/exchange") {
          return Response.json({
            peerId: "peer",
            frontier: [],
            load: { queueDepth: 0 },
            capabilities: {},
            timestamp: new Date().toISOString(),
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    serverUrl = `http://localhost:${mockServer.port}`;

    const { lines, writer } = createOutput();
    await handleGossip(["sync", `s@${serverUrl}`, "--json"], undefined, withCliDepsTest, writer);

    // Find the JSON output (after the progress messages)
    const jsonLine = lines.find((l) => l.startsWith("{"));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine as string);
    expect(parsed).toHaveProperty("peersDiscovered");
    expect(parsed).toHaveProperty("newCids");
  });
});

// ---------------------------------------------------------------------------
// Peer management: add-peer
// ---------------------------------------------------------------------------

describe("gossip add-peer", () => {
  test("adds a peer to local gossip store", async () => {
    const groveDir = join(tmpDir, ".grove");
    const { lines, writer } = createOutput();
    await handleGossip(["add-peer", "node1@http://host1:4515"], groveDir, undefined, writer);

    expect(lines.join("\n")).toContain("Added peer: node1");
    expect(lines.join("\n")).toContain("http://host1:4515");

    // Verify it was persisted
    const store = new SqliteGossipStore(join(groveDir, "gossip.db"));
    try {
      const peers = store.loadPeers();
      expect(peers).toHaveLength(1);
      expect(peers[0]?.peerId).toBe("node1");
      expect(peers[0]?.address).toBe("http://host1:4515");
    } finally {
      store.close();
    }
  });

  test("reports when peer already exists", async () => {
    const groveDir = join(tmpDir, ".grove");

    // Add first time
    const { writer: w1 } = createOutput();
    await handleGossip(["add-peer", "node1@http://host1:4515"], groveDir, undefined, w1);

    // Add again
    const { lines, writer } = createOutput();
    await handleGossip(["add-peer", "node1@http://host1:4515"], groveDir, undefined, writer);

    expect(lines.join("\n")).toContain("already exists");
  });

  test("throws without peer spec", async () => {
    const groveDir = join(tmpDir, ".grove");
    const { writer } = createOutput();
    await expect(handleGossip(["add-peer"], groveDir, undefined, writer)).rejects.toThrow(
      "peerId@address",
    );
  });

  test("throws for invalid peer format", async () => {
    const groveDir = join(tmpDir, ".grove");
    const { writer } = createOutput();
    await expect(
      handleGossip(["add-peer", "no-at-sign"], groveDir, undefined, writer),
    ).rejects.toThrow("peerId@address");
  });
});

// ---------------------------------------------------------------------------
// Peer management: remove-peer
// ---------------------------------------------------------------------------

describe("gossip remove-peer", () => {
  test("removes a peer from local gossip store", async () => {
    const groveDir = join(tmpDir, ".grove");

    // Add a peer first
    const { writer: w1 } = createOutput();
    await handleGossip(["add-peer", "node1@http://host1:4515"], groveDir, undefined, w1);

    // Remove it
    const { lines, writer } = createOutput();
    await handleGossip(["remove-peer", "node1"], groveDir, undefined, writer);

    expect(lines.join("\n")).toContain("Removed peer: node1");

    // Verify it was removed
    const store = new SqliteGossipStore(join(groveDir, "gossip.db"));
    try {
      const peers = store.loadPeers();
      expect(peers).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("reports when peer not found", async () => {
    const groveDir = join(tmpDir, ".grove");
    const { lines, writer } = createOutput();
    await handleGossip(["remove-peer", "nonexistent"], groveDir, undefined, writer);

    expect(lines.join("\n")).toContain("not found");
  });

  test("throws without peer ID", async () => {
    const groveDir = join(tmpDir, ".grove");
    const { writer } = createOutput();
    await expect(handleGossip(["remove-peer"], groveDir, undefined, writer)).rejects.toThrow(
      "peerId",
    );
  });
});

// ---------------------------------------------------------------------------
// Watch (single poll iteration via mock)
// ---------------------------------------------------------------------------

describe("gossip watch", () => {
  test("detects new peer via polling", async () => {
    let callCount = 0;
    mockServer = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/api/gossip/peers") {
          callCount++;
          // First call: empty, second call: one peer
          if (callCount <= 1) {
            return Response.json({ peers: [], liveness: [] });
          }
          return Response.json({
            peers: [{ peerId: "p1", address: "http://h:1", age: 0, lastSeen: "" }],
            liveness: [
              {
                peer: { peerId: "p1", address: "http://h:1", age: 0, lastSeen: "" },
                status: "alive",
                lastSeen: "2025-01-01T00:00:00Z",
              },
            ],
          });
        }
        if (path === "/api/gossip/frontier") {
          return Response.json({ entries: [] });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    serverUrl = `http://localhost:${mockServer.port}`;

    const { lines, writer } = createOutput();

    // Run watch with very short interval, stop after detecting event
    const watchPromise = handleGossip(
      ["watch", "--server", serverUrl, "--interval", "1"],
      undefined,
      undefined,
      writer,
    );

    // Let it poll a few times then stop
    await Bun.sleep(3500);
    process.emit("SIGINT", "SIGINT");

    await watchPromise;

    const text = lines.join("\n");
    expect(text).toContain("Watching gossip events");
    expect(text).toContain("peer_joined");
    expect(text).toContain("p1");
  });
});

// ---------------------------------------------------------------------------
// Help text includes new commands
// ---------------------------------------------------------------------------

describe("gossip help completeness", () => {
  test("help includes all subcommands", async () => {
    const { lines, writer } = createOutput();
    await handleGossip(["--help"], undefined, undefined, writer);

    const text = lines.join("\n");
    expect(text).toContain("daemon");
    expect(text).toContain("watch");
    expect(text).toContain("add-peer");
    expect(text).toContain("remove-peer");
  });
});
