import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FrontierDigestEntry, PeerInfo } from "../core/gossip/types.js";
import { SqliteGossipStore } from "./gossip-store.js";

describe("SqliteGossipStore", () => {
  let dir: string;
  let store: SqliteGossipStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gossip-store-"));
    store = new SqliteGossipStore(join(dir, "gossip.db"));
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Peers
  // -------------------------------------------------------------------------

  test("loadPeers returns empty array for fresh database", () => {
    expect(store.loadPeers()).toEqual([]);
  });

  test("addPeer stores and loads a peer", () => {
    const peer: PeerInfo = {
      peerId: "peer-1",
      address: "http://localhost:3001",
      age: 0,
      lastSeen: "2025-01-01T00:00:00.000Z",
    };

    expect(store.addPeer(peer)).toBe(true);
    const loaded = store.loadPeers();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(peer);
  });

  test("addPeer returns false for duplicate peer", () => {
    const peer: PeerInfo = {
      peerId: "peer-1",
      address: "http://localhost:3001",
      age: 0,
      lastSeen: "2025-01-01T00:00:00.000Z",
    };

    expect(store.addPeer(peer)).toBe(true);
    expect(store.addPeer(peer)).toBe(false);
    expect(store.loadPeers()).toHaveLength(1);
  });

  test("removePeer removes an existing peer", () => {
    const peer: PeerInfo = {
      peerId: "peer-1",
      address: "http://localhost:3001",
      age: 0,
      lastSeen: "2025-01-01T00:00:00.000Z",
    };

    store.addPeer(peer);
    expect(store.removePeer("peer-1")).toBe(true);
    expect(store.loadPeers()).toEqual([]);
  });

  test("removePeer returns false for non-existent peer", () => {
    expect(store.removePeer("no-such-peer")).toBe(false);
  });

  test("savePeers replaces all existing peers", () => {
    const original: PeerInfo = {
      peerId: "peer-1",
      address: "http://localhost:3001",
      age: 0,
      lastSeen: "2025-01-01T00:00:00.000Z",
    };
    store.addPeer(original);

    const replacements: PeerInfo[] = [
      {
        peerId: "peer-2",
        address: "http://localhost:3002",
        age: 1,
        lastSeen: "2025-02-01T00:00:00.000Z",
      },
      {
        peerId: "peer-3",
        address: "http://localhost:3003",
        age: 2,
        lastSeen: "2025-03-01T00:00:00.000Z",
      },
    ];

    store.savePeers(replacements);
    const loaded = store.loadPeers();
    expect(loaded).toHaveLength(2);
    expect(loaded.map((p) => p.peerId).sort()).toEqual(["peer-2", "peer-3"]);
  });

  test("savePeers with empty array clears all peers", () => {
    store.addPeer({
      peerId: "peer-1",
      address: "http://localhost:3001",
      age: 0,
      lastSeen: "2025-01-01T00:00:00.000Z",
    });

    store.savePeers([]);
    expect(store.loadPeers()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Frontier
  // -------------------------------------------------------------------------

  test("loadFrontier returns empty array for fresh database", () => {
    expect(store.loadFrontier()).toEqual([]);
  });

  test("saveFrontier stores and loads entries", () => {
    const entries: FrontierDigestEntry[] = [
      { metric: "accuracy", cid: "cid-1", value: 0.95 },
      { metric: "latency", cid: "cid-2", value: 42 },
    ];

    store.saveFrontier(entries);
    const loaded = store.loadFrontier();
    expect(loaded).toHaveLength(2);
    expect(loaded).toEqual(
      expect.arrayContaining([
        { metric: "accuracy", cid: "cid-1", value: 0.95 },
        { metric: "latency", cid: "cid-2", value: 42 },
      ]),
    );
  });

  test("saveFrontier preserves tags", () => {
    const entries: FrontierDigestEntry[] = [
      { metric: "accuracy", cid: "cid-1", value: 0.95, tags: ["v1", "prod"] },
    ];

    store.saveFrontier(entries);
    const loaded = store.loadFrontier();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.tags).toEqual(["v1", "prod"]);
  });

  test("saveFrontier omits tags key when null", () => {
    const entries: FrontierDigestEntry[] = [{ metric: "accuracy", cid: "cid-1", value: 0.95 }];

    store.saveFrontier(entries);
    const loaded = store.loadFrontier();
    expect(loaded).toHaveLength(1);
    expect("tags" in (loaded[0] ?? {})).toBe(false);
  });

  test("saveFrontier replaces all existing entries", () => {
    store.saveFrontier([{ metric: "old", cid: "cid-0", value: 1 }]);
    store.saveFrontier([{ metric: "new", cid: "cid-1", value: 2 }]);

    const loaded = store.loadFrontier();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.metric).toBe("new");
  });

  test("saveFrontier with empty array clears all entries", () => {
    store.saveFrontier([{ metric: "m", cid: "c", value: 1 }]);
    store.saveFrontier([]);
    expect(store.loadFrontier()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Persistence across re-open
  // -------------------------------------------------------------------------

  test("data persists after close and re-open", () => {
    const dbPath = join(dir, "gossip.db");
    store.close();

    const store1 = new SqliteGossipStore(dbPath);
    store1.addPeer({
      peerId: "peer-1",
      address: "http://localhost:3001",
      age: 0,
      lastSeen: "2025-01-01T00:00:00.000Z",
    });
    store1.saveFrontier([{ metric: "m", cid: "c", value: 1 }]);
    store1.close();

    const store2 = new SqliteGossipStore(dbPath);
    expect(store2.loadPeers()).toHaveLength(1);
    expect(store2.loadFrontier()).toHaveLength(1);
    store2.close();

    // Re-assign store so afterEach cleanup works
    store = new SqliteGossipStore(dbPath);
  });
});
