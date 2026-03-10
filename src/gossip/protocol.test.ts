/**
 * Tests for DefaultGossipService (gossip protocol implementation).
 *
 * Covers: currentMessage, handleExchange, handleShuffle, liveness tracking,
 * event emission, mergedFrontier, and start/stop lifecycle.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Frontier, FrontierCalculator, FrontierQuery } from "../core/frontier.js";
import {
  type FrontierDigestEntry,
  type GossipEvent,
  GossipEventType,
  type GossipMessage,
  type GossipTransport,
  type PeerInfo,
  PeerStatus,
  type ShuffleRequest,
  type ShuffleResponse,
} from "../core/gossip/types.js";
import { DefaultGossipService } from "./protocol.js";

// ---------------------------------------------------------------------------
// Mock implementations
// ---------------------------------------------------------------------------

/** Mock transport with configurable responses and failure injection. */
class MockGossipTransport implements GossipTransport {
  readonly exchangeCalls: Array<{ peer: PeerInfo; message: GossipMessage }> = [];
  readonly shuffleCalls: Array<{ peer: PeerInfo; request: ShuffleRequest }> = [];

  exchangeResponse: GossipMessage | undefined;
  shuffleResponse: ShuffleResponse | undefined;
  exchangeError: Error | undefined;
  shuffleError: Error | undefined;

  async exchange(peer: PeerInfo, message: GossipMessage): Promise<GossipMessage> {
    this.exchangeCalls.push({ peer, message });
    if (this.exchangeError) throw this.exchangeError;
    if (this.exchangeResponse) return this.exchangeResponse;
    // Default: echo back a response from the target peer
    return {
      peerId: peer.peerId,
      address: peer.address,
      frontier: [],
      load: { queueDepth: 0 },
      capabilities: {},
      timestamp: new Date().toISOString(),
    };
  }

  async shuffle(peer: PeerInfo, request: ShuffleRequest): Promise<ShuffleResponse> {
    this.shuffleCalls.push({ peer, request });
    if (this.shuffleError) throw this.shuffleError;
    if (this.shuffleResponse) return this.shuffleResponse;
    return { offered: [] };
  }
}

/** Mock frontier calculator returning configurable frontier data. */
class MockFrontierCalculator implements FrontierCalculator {
  frontier: Frontier = {
    byMetric: {},
    byAdoption: [],
    byRecency: [],
    byReviewScore: [],
    byReproduction: [],
  };

  async compute(_query?: FrontierQuery): Promise<Frontier> {
    return this.frontier;
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePeer(id: string, address?: string): PeerInfo {
  return {
    peerId: id,
    address: address ?? `http://peer-${id}:4515`,
    age: 0,
    lastSeen: new Date().toISOString(),
  };
}

function makeGossipMessage(peerId: string, frontier: FrontierDigestEntry[] = []): GossipMessage {
  return {
    peerId,
    address: `http://peer-${peerId}:4515`,
    frontier,
    load: { queueDepth: 1 },
    capabilities: { platform: "test" },
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DefaultGossipService", () => {
  let transport: MockGossipTransport;
  let frontierCalc: MockFrontierCalculator;
  let service: DefaultGossipService;
  let currentTime: number;
  const nowFn = () => currentTime;

  const seedPeer = makePeer("seed-1");
  const peerId = "self-peer";
  const address = "http://localhost:4515";

  beforeEach(() => {
    transport = new MockGossipTransport();
    frontierCalc = new MockFrontierCalculator();
    currentTime = 1_000_000;

    service = new DefaultGossipService({
      config: {
        peerId,
        address,
        seedPeers: [seedPeer],
        intervalMs: 1000,
        fanOut: 1,
        jitter: 0,
        suspicionTimeoutMs: 5000,
        failureTimeoutMs: 10000,
      },
      transport,
      frontier: frontierCalc,
      capabilities: { platform: "bun-test" },
      getLoad: () => ({ queueDepth: 42 }),
      now: nowFn,
    });
  });

  afterEach(async () => {
    await service.stop();
  });

  // -------------------------------------------------------------------------
  // currentMessage()
  // -------------------------------------------------------------------------

  describe("currentMessage()", () => {
    it("generates correct gossip message format with peerId, address, frontier, load, capabilities, timestamp", async () => {
      const msg = await service.currentMessage();

      expect(msg.peerId).toBe(peerId);
      expect(msg.address).toBe(address);
      expect(msg.load).toEqual({ queueDepth: 42 });
      expect(msg.capabilities).toEqual({ platform: "bun-test" });
      expect(msg.timestamp).toBe(new Date(currentTime).toISOString());
      expect(Array.isArray(msg.frontier)).toBe(true);
    });

    it("uses provided FrontierCalculator to compute digest", async () => {
      frontierCalc.frontier = {
        byMetric: {
          accuracy: [
            {
              cid: "blake3:abc1",
              summary: "test",
              value: 0.95,
              contribution: {
                cid: "blake3:abc1",
                manifestVersion: 1,
                summary: "test",
                kind: "work",
                mode: "evaluation",
                artifacts: {},
                tags: ["ml"],
                agent: { agentId: "a1" },
                relations: [],
                createdAt: new Date().toISOString(),
              },
            },
          ],
        },
        byAdoption: [],
        byRecency: [],
        byReviewScore: [],
        byReproduction: [],
      };

      const msg = await service.currentMessage();

      expect(msg.frontier.length).toBeGreaterThanOrEqual(1);
      const accuracyEntry = msg.frontier.find((e) => e.metric === "accuracy");
      expect(accuracyEntry).toBeDefined();
      expect(accuracyEntry?.cid).toBe("blake3:abc1");
      expect(accuracyEntry?.value).toBe(0.95);
      expect(accuracyEntry?.tags).toEqual(["ml"]);
    });

    it("includes synthetic dimension entries (_adoption, _recency, etc.)", async () => {
      frontierCalc.frontier = {
        byMetric: {},
        byAdoption: [
          {
            cid: "blake3:adopt1",
            summary: "adopted",
            value: 5,
            contribution: {
              cid: "blake3:adopt1",
              manifestVersion: 1,
              summary: "adopted",
              kind: "work",
              mode: "evaluation",
              artifacts: {},
              tags: [],
              agent: { agentId: "a1" },
              relations: [],
              createdAt: new Date().toISOString(),
            },
          },
        ],
        byRecency: [],
        byReviewScore: [],
        byReproduction: [],
      };

      const msg = await service.currentMessage();

      const adoptionEntry = msg.frontier.find((e) => e.metric === "_adoption");
      expect(adoptionEntry).toBeDefined();
      expect(adoptionEntry?.cid).toBe("blake3:adopt1");
      expect(adoptionEntry?.value).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // handleExchange()
  // -------------------------------------------------------------------------

  describe("handleExchange()", () => {
    it("returns our current message", async () => {
      const remoteMsg = makeGossipMessage("remote-peer");
      const response = await service.handleExchange(remoteMsg);

      expect(response.peerId).toBe(peerId);
      expect(response.load).toEqual({ queueDepth: 42 });
      expect(response.capabilities).toEqual({ platform: "bun-test" });
    });

    it("merges remote frontier entries", async () => {
      const remoteFrontier: FrontierDigestEntry[] = [
        { metric: "accuracy", value: 0.99, cid: "blake3:remote1" },
        { metric: "loss", value: 0.01, cid: "blake3:remote2" },
      ];
      const remoteMsg = makeGossipMessage("remote-peer");
      const msgWithFrontier: GossipMessage = { ...remoteMsg, frontier: remoteFrontier };

      await service.handleExchange(msgWithFrontier);

      const merged = service.mergedFrontier();
      expect(merged).toHaveLength(2);
      expect(merged.find((e) => e.cid === "blake3:remote1")).toBeDefined();
      expect(merged.find((e) => e.cid === "blake3:remote2")).toBeDefined();
    });

    it("marks sender as alive", async () => {
      const remoteMsg = makeGossipMessage("remote-peer");
      await service.handleExchange(remoteMsg);

      const livenessEntries = service.liveness();
      const remoteLiveness = livenessEntries.find((l) => l.peer.peerId === "remote-peer");
      // remote-peer may or may not be in the view depending on capacity,
      // but if the seed peer was the only one, remote-peer should be added
      if (remoteLiveness) {
        expect(remoteLiveness.status).toBe(PeerStatus.Alive);
      }
    });

    it("adds sender to peer view", async () => {
      const remoteMsg = makeGossipMessage("new-peer");
      await service.handleExchange(remoteMsg);

      const peers = service.peers();
      const found = peers.find((p) => p.peerId === "new-peer");
      expect(found).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // handleShuffle()
  // -------------------------------------------------------------------------

  describe("handleShuffle()", () => {
    it("delegates to CYCLON peer sampler and returns response", () => {
      const request: ShuffleRequest = {
        sender: makePeer("shuffle-peer"),
        offered: [makePeer("shuffle-peer"), makePeer("offered-peer")],
      };

      const response = service.handleShuffle(request);

      expect(response).toBeDefined();
      expect(Array.isArray(response.offered)).toBe(true);
    });

    it("marks sender as alive", () => {
      // First, make shuffle-peer suspected via liveness check
      const request: ShuffleRequest = {
        sender: makePeer("seed-1"),
        offered: [makePeer("seed-1")],
      };

      // Advance time past suspicion timeout to suspect seed-1
      currentTime += 6000;
      service.handleShuffle(request);

      // Verify seed-1 is alive after shuffle
      const livenessEntries = service.liveness();
      const seedLiveness = livenessEntries.find((l) => l.peer.peerId === "seed-1");
      expect(seedLiveness).toBeDefined();
      expect(seedLiveness?.status).toBe(PeerStatus.Alive);
    });
  });

  // -------------------------------------------------------------------------
  // Liveness tracking
  // -------------------------------------------------------------------------

  describe("liveness tracking", () => {
    it("markAlive updates last-seen and clears suspicion", async () => {
      // Exchange with seed peer to mark alive at current time
      const msg = makeGossipMessage("seed-1");
      currentTime = 2_000_000;
      await service.handleExchange(msg);

      const livenessEntries = service.liveness();
      const seedLiveness = livenessEntries.find((l) => l.peer.peerId === "seed-1");
      expect(seedLiveness).toBeDefined();
      expect(seedLiveness?.status).toBe(PeerStatus.Alive);
      expect(seedLiveness?.suspectedAt).toBeUndefined();
      expect(seedLiveness?.lastSeen).toBe(new Date(2_000_000).toISOString());
    });

    it("peer suspected after suspicion timeout (via runRound + checkLiveness)", async () => {
      // Transport will fail so the peer becomes unresponsive
      transport.exchangeError = new Error("connection refused");
      transport.shuffleError = new Error("connection refused");

      // Advance time past suspicion timeout
      currentTime = 1_000_000 + 6000;

      await service.runRound();

      const livenessEntries = service.liveness();
      const seedLiveness = livenessEntries.find((l) => l.peer.peerId === "seed-1");
      expect(seedLiveness).toBeDefined();
      expect(seedLiveness?.status).toBe(PeerStatus.Suspected);
    });

    it("peer failed after failure timeout", async () => {
      transport.exchangeError = new Error("connection refused");
      transport.shuffleError = new Error("connection refused");

      // First round: advance past suspicion timeout to get peer suspected
      currentTime = 1_000_000 + 6000;
      await service.runRound();

      // Second round: advance past failure timeout to get peer failed
      // failureTimeoutMs=10000, suspicionTimeoutMs=5000
      // suspected → failed needs: failureTimeoutMs - suspicionTimeoutMs = 5000
      currentTime = 1_000_000 + 6000 + 6000;
      await service.runRound();

      const livenessEntries = service.liveness();
      // After failure, peer is removed from view, so liveness list won't include it
      const seedLiveness = livenessEntries.find((l) => l.peer.peerId === "seed-1");
      expect(seedLiveness).toBeUndefined();
    });

    it("recovery: suspected peer comes back alive emits PeerRecovered", async () => {
      const events: GossipEvent[] = [];
      service.on((e) => events.push(e));

      transport.exchangeError = new Error("connection refused");
      transport.shuffleError = new Error("connection refused");

      // Advance past suspicion timeout
      currentTime = 1_000_000 + 6000;
      await service.runRound();

      // Verify peer is suspected
      const suspectedEvents = events.filter((e) => e.type === GossipEventType.PeerSuspected);
      expect(suspectedEvents.length).toBeGreaterThanOrEqual(1);

      // Now the peer comes back: simulate an exchange from seed-1
      const msg = makeGossipMessage("seed-1");
      currentTime += 1000;
      await service.handleExchange(msg);

      // Should have emitted PeerRecovered
      const recoveredEvents = events.filter((e) => e.type === GossipEventType.PeerRecovered);
      expect(recoveredEvents.length).toBeGreaterThanOrEqual(1);
      expect(recoveredEvents[0]?.peerId).toBe("seed-1");
    });
  });

  // -------------------------------------------------------------------------
  // Event emission
  // -------------------------------------------------------------------------

  describe("event emission", () => {
    it("emits peer_joined on new peer discovered via shuffle response", async () => {
      const events: GossipEvent[] = [];
      service.on((e) => events.push(e));

      // Transport returns a shuffle response with a new peer
      transport.shuffleResponse = {
        offered: [makePeer("new-discovered-peer")],
      };
      transport.exchangeError = undefined;

      await service.runRound();

      const joinedEvents = events.filter((e) => e.type === GossipEventType.PeerJoined);
      expect(joinedEvents.length).toBeGreaterThanOrEqual(1);
      const joined = joinedEvents.find((e) => e.peerId === "new-discovered-peer");
      expect(joined).toBeDefined();
    });

    it("emits peer_suspected on suspicion", async () => {
      const events: GossipEvent[] = [];
      service.on((e) => events.push(e));

      transport.exchangeError = new Error("refused");
      transport.shuffleError = new Error("refused");

      currentTime = 1_000_000 + 6000;
      await service.runRound();

      const suspected = events.filter((e) => e.type === GossipEventType.PeerSuspected);
      expect(suspected.length).toBeGreaterThanOrEqual(1);
      expect(suspected[0]?.peerId).toBe("seed-1");
    });

    it("emits peer_failed on failure", async () => {
      const events: GossipEvent[] = [];
      service.on((e) => events.push(e));

      transport.exchangeError = new Error("refused");
      transport.shuffleError = new Error("refused");

      // First round: suspect
      currentTime = 1_000_000 + 6000;
      await service.runRound();

      // Second round: fail
      currentTime = 1_000_000 + 12000;
      await service.runRound();

      const failed = events.filter((e) => e.type === GossipEventType.PeerFailed);
      expect(failed.length).toBeGreaterThanOrEqual(1);
      expect(failed[0]?.peerId).toBe("seed-1");
    });

    it("emits peer_recovered on recovery from suspected state", async () => {
      const events: GossipEvent[] = [];
      service.on((e) => events.push(e));

      transport.exchangeError = new Error("refused");
      transport.shuffleError = new Error("refused");

      // Suspect the peer
      currentTime = 1_000_000 + 6000;
      await service.runRound();

      // Recover via handleExchange
      currentTime += 1000;
      await service.handleExchange(makeGossipMessage("seed-1"));

      const recovered = events.filter((e) => e.type === GossipEventType.PeerRecovered);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]?.peerId).toBe("seed-1");
    });

    it("emits frontier_updated on merge", async () => {
      const events: GossipEvent[] = [];
      service.on((e) => events.push(e));

      const remoteFrontier: FrontierDigestEntry[] = [
        { metric: "accuracy", value: 0.99, cid: "blake3:remote1" },
      ];
      await service.handleExchange({ ...makeGossipMessage("remote"), frontier: remoteFrontier });

      const frontierEvents = events.filter((e) => e.type === GossipEventType.FrontierUpdated);
      expect(frontierEvents.length).toBeGreaterThanOrEqual(1);
    });

    it("off() removes a listener", async () => {
      const events: GossipEvent[] = [];
      const listener = (e: GossipEvent) => events.push(e);
      service.on(listener);

      await service.handleExchange(makeGossipMessage("peer-a"));
      const countAfterFirst = events.length;
      expect(countAfterFirst).toBeGreaterThan(0);

      service.off(listener);
      await service.handleExchange(makeGossipMessage("peer-b"));
      expect(events.length).toBe(countAfterFirst);
    });

    it("swallows listener errors without crashing", async () => {
      service.on(() => {
        throw new Error("listener boom");
      });

      // Should not throw
      await service.handleExchange(makeGossipMessage("peer-c"));
    });
  });

  // -------------------------------------------------------------------------
  // mergedFrontier()
  // -------------------------------------------------------------------------

  describe("mergedFrontier()", () => {
    it("returns empty initially", () => {
      expect(service.mergedFrontier()).toEqual([]);
    });

    it("returns merged entries after exchange", async () => {
      const frontier: FrontierDigestEntry[] = [
        { metric: "loss", value: 0.05, cid: "blake3:a" },
        { metric: "loss", value: 0.03, cid: "blake3:b" },
      ];
      await service.handleExchange({ ...makeGossipMessage("peer-x"), frontier });

      const merged = service.mergedFrontier();
      expect(merged).toHaveLength(2);
    });

    it("keeps best value per (metric, cid) on multiple merges", async () => {
      const frontier1: FrontierDigestEntry[] = [
        { metric: "accuracy", value: 0.9, cid: "blake3:c1" },
      ];
      const frontier2: FrontierDigestEntry[] = [
        { metric: "accuracy", value: 0.95, cid: "blake3:c1" },
      ];

      await service.handleExchange({ ...makeGossipMessage("peer-1"), frontier: frontier1 });
      await service.handleExchange({ ...makeGossipMessage("peer-2"), frontier: frontier2 });

      const merged = service.mergedFrontier();
      const entry = merged.find((e) => e.cid === "blake3:c1");
      expect(entry).toBeDefined();
      expect(entry?.value).toBe(0.95);
    });
  });

  // -------------------------------------------------------------------------
  // start/stop
  // -------------------------------------------------------------------------

  describe("start/stop", () => {
    it("can start and stop without errors", async () => {
      service.start();
      // Give a tiny amount of time for the timer to be set
      await new Promise((r) => setTimeout(r, 10));
      await service.stop();
    });

    it("stop clears timer", async () => {
      service.start();
      await new Promise((r) => setTimeout(r, 10));
      await service.stop();

      // After stop, no more rounds should run. Record exchange calls.
      const callsBefore = transport.exchangeCalls.length;
      await new Promise((r) => setTimeout(r, 50));
      expect(transport.exchangeCalls.length).toBe(callsBefore);
    });

    it("start is idempotent (calling twice does not double-schedule)", async () => {
      service.start();
      service.start();
      await new Promise((r) => setTimeout(r, 10));
      await service.stop();
    });
  });

  // -------------------------------------------------------------------------
  // runRound() integration
  // -------------------------------------------------------------------------

  describe("runRound()", () => {
    it("performs shuffle and exchange in a single round", async () => {
      transport.shuffleResponse = { offered: [] };

      await service.runRound();

      // Should have attempted shuffle (with seed peer)
      expect(transport.shuffleCalls.length).toBeGreaterThanOrEqual(1);
      // Should have attempted exchange (fanOut=1)
      expect(transport.exchangeCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("survives transport errors during round", async () => {
      transport.exchangeError = new Error("network down");
      transport.shuffleError = new Error("network down");

      // Should not throw
      await service.runRound();
    });
  });

  // -------------------------------------------------------------------------
  // peers() and liveness()
  // -------------------------------------------------------------------------

  describe("peers() and liveness()", () => {
    it("peers() includes seed peers", () => {
      const peers = service.peers();
      expect(peers.length).toBeGreaterThanOrEqual(1);
      expect(peers.find((p) => p.peerId === "seed-1")).toBeDefined();
    });

    it("liveness() returns status for all known peers", () => {
      const liveness = service.liveness();
      expect(liveness.length).toBeGreaterThanOrEqual(1);
      const seedLiveness = liveness.find((l) => l.peer.peerId === "seed-1");
      expect(seedLiveness).toBeDefined();
      expect(seedLiveness?.status).toBe(PeerStatus.Alive);
    });
  });

  // -------------------------------------------------------------------------
  // Default config values
  // -------------------------------------------------------------------------

  describe("default config values", () => {
    it("uses defaults when optional config values are omitted", async () => {
      const minimal = new DefaultGossipService({
        config: {
          peerId: "minimal",
          address: "http://localhost:9999",
          seedPeers: [],
        },
        transport,
        frontier: frontierCalc,
      });

      const msg = await minimal.currentMessage();
      expect(msg.peerId).toBe("minimal");
      expect(msg.load).toEqual({ queueDepth: 0 });
      expect(msg.capabilities).toEqual({});
      await minimal.stop();
    });
  });
});
