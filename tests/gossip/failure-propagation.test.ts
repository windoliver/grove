/**
 * Failure detection and propagation tests.
 *
 * Validates the full lifecycle: peer stops responding -> suspected ->
 * failed -> removed, as well as recovery and integration with
 * downstream consumers via event listeners.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Frontier, FrontierCalculator } from "../../src/core/frontier.js";
import { PeerUnreachableError } from "../../src/core/gossip/errors.js";
import {
  type GossipConfig,
  type GossipEvent,
  GossipEventType,
  type GossipMessage,
  type GossipTransport,
  type PeerInfo,
  PeerStatus,
  type ShuffleRequest,
  type ShuffleResponse,
} from "../../src/core/gossip/types.js";
import { DefaultGossipService } from "../../src/gossip/protocol.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createPeer(id: string): PeerInfo {
  return {
    peerId: id,
    address: `http://peer-${id}:4515`,
    age: 0,
    lastSeen: new Date().toISOString(),
  };
}

/** Empty frontier result for the mock calculator. */
const EMPTY_FRONTIER: Frontier = {
  byMetric: {},
  byAdoption: [],
  byRecency: [],
  byReviewScore: [],
  byReproduction: [],
};

// ---------------------------------------------------------------------------
// Mock implementations
// ---------------------------------------------------------------------------

/**
 * Mock transport that can be configured to throw PeerUnreachableError
 * for specific peer IDs. Supports switching between throwing and
 * succeeding at runtime.
 */
class MockGossipTransport implements GossipTransport {
  /** Set of peer IDs that will cause transport errors. */
  private readonly unreachablePeers = new Set<string>();

  /** Count of exchange calls per peer. */
  readonly exchangeCalls = new Map<string, number>();

  /** Count of shuffle calls per peer. */
  readonly shuffleCalls = new Map<string, number>();

  /** Make a peer unreachable (transport will throw). */
  markUnreachable(peerId: string): void {
    this.unreachablePeers.add(peerId);
  }

  /** Make a peer reachable again (transport will succeed). */
  markReachable(peerId: string): void {
    this.unreachablePeers.delete(peerId);
  }

  async exchange(peer: PeerInfo, _message: GossipMessage): Promise<GossipMessage> {
    this.exchangeCalls.set(peer.peerId, (this.exchangeCalls.get(peer.peerId) ?? 0) + 1);

    if (this.unreachablePeers.has(peer.peerId)) {
      throw new PeerUnreachableError({
        peerId: peer.peerId,
        address: peer.address,
      });
    }

    // Return a valid gossip message from the "peer"
    return {
      peerId: peer.peerId,
      frontier: [],
      load: { queueDepth: 0 },
      capabilities: {},
      timestamp: new Date().toISOString(),
    };
  }

  async shuffle(peer: PeerInfo, _request: ShuffleRequest): Promise<ShuffleResponse> {
    this.shuffleCalls.set(peer.peerId, (this.shuffleCalls.get(peer.peerId) ?? 0) + 1);

    if (this.unreachablePeers.has(peer.peerId)) {
      throw new PeerUnreachableError({
        peerId: peer.peerId,
        address: peer.address,
      });
    }

    // Return an empty shuffle response
    return { offered: [] };
  }

  async fetchContribution(_peer: PeerInfo, _cid: string): Promise<unknown | undefined> {
    return undefined;
  }

  async fetchArtifact(_peer: PeerInfo, _contentHash: string): Promise<Uint8Array | undefined> {
    return undefined;
  }
}

/** Mock frontier calculator that returns an empty frontier. */
class MockFrontierCalculator implements FrontierCalculator {
  async compute(): Promise<Frontier> {
    return EMPTY_FRONTIER;
  }
}

/**
 * Create a DefaultGossipService with mock dependencies and
 * deterministic time control.
 */
function createService(opts: {
  peerId: string;
  seedPeers: readonly PeerInfo[];
  transport: MockGossipTransport;
  now: () => number;
  suspicionTimeoutMs?: number;
  failureTimeoutMs?: number;
  fanOut?: number;
  maxViewSize?: number;
}): DefaultGossipService {
  const config: GossipConfig = {
    peerId: opts.peerId,
    address: `http://peer-${opts.peerId}:4515`,
    seedPeers: opts.seedPeers,
    intervalMs: 1000, // Short interval (not used in manual runRound)
    fanOut: opts.fanOut ?? 3,
    jitter: 0,
    maxViewSize: opts.maxViewSize ?? 10,
    shuffleLength: 3,
    suspicionTimeoutMs: opts.suspicionTimeoutMs ?? 5000,
    failureTimeoutMs: opts.failureTimeoutMs ?? 15000,
  };

  return new DefaultGossipService({
    config,
    transport: opts.transport,
    frontier: new MockFrontierCalculator(),
    now: opts.now,
  });
}

/** Collect gossip events into an array for assertions. */
function collectEvents(service: DefaultGossipService): GossipEvent[] {
  const events: GossipEvent[] = [];
  service.on((event) => events.push(event));
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Failure propagation", () => {
  let transport: MockGossipTransport;
  let currentTime: number;

  beforeEach(() => {
    transport = new MockGossipTransport();
    currentTime = 1_000_000;
  });

  const now = (): number => currentTime;

  describe("peer stops responding -> suspected -> failed", () => {
    it("emits peer_suspected after suspicion timeout", async () => {
      const peerA = createPeer("a");
      const service = createService({
        peerId: "self",
        seedPeers: [peerA],
        transport,
        now,
        suspicionTimeoutMs: 5000,
        failureTimeoutMs: 15000,
      });

      const events = collectEvents(service);

      // First round succeeds (peer is alive)
      await service.runRound();

      // Make peer unreachable
      transport.markUnreachable("a");

      // Run a round - peer will fail to respond, marking it suspected
      await service.runRound();

      // Advance time past suspicion timeout
      currentTime += 6000;

      // Run another round to trigger liveness check
      await service.runRound();

      const suspected = events.filter((e) => e.type === GossipEventType.PeerSuspected);
      expect(suspected.length).toBeGreaterThanOrEqual(1);
      expect(suspected.some((e) => e.peerId === "a")).toBe(true);
    });

    it("emits peer_failed after failure timeout", async () => {
      const peerA = createPeer("a");
      const service = createService({
        peerId: "self",
        seedPeers: [peerA],
        transport,
        now,
        suspicionTimeoutMs: 5000,
        failureTimeoutMs: 15000,
      });

      const events = collectEvents(service);

      // First round succeeds
      await service.runRound();

      // Make peer unreachable
      transport.markUnreachable("a");

      // Run round to mark as suspected
      await service.runRound();

      // Advance past failure timeout (failureTimeoutMs - suspicionTimeoutMs = 10s)
      currentTime += 11000;

      // Run round to trigger failure detection
      await service.runRound();

      const failed = events.filter((e) => e.type === GossipEventType.PeerFailed);
      expect(failed.length).toBeGreaterThanOrEqual(1);
      expect(failed.some((e) => e.peerId === "a")).toBe(true);
    });

    it("removes failed peer from view", async () => {
      const peerA = createPeer("a");
      const peerB = createPeer("b");
      const service = createService({
        peerId: "self",
        seedPeers: [peerA, peerB],
        transport,
        now,
        suspicionTimeoutMs: 5000,
        failureTimeoutMs: 15000,
      });

      // First round succeeds for both
      await service.runRound();

      // Make peer A unreachable
      transport.markUnreachable("a");

      // Run round to mark as suspected
      await service.runRound();

      // Advance past failure timeout
      currentTime += 11000;

      // Run round to trigger failure
      await service.runRound();

      // Peer A should be removed from view
      const peerIds = service.peers().map((p) => p.peerId);
      expect(peerIds).not.toContain("a");

      // Peer B should still be in the view
      expect(peerIds).toContain("b");
    });

    it("transitions through alive -> suspected -> failed states", async () => {
      const peerA = createPeer("a");
      const service = createService({
        peerId: "self",
        seedPeers: [peerA],
        transport,
        now,
        suspicionTimeoutMs: 5000,
        failureTimeoutMs: 15000,
      });

      // Initially alive
      const initialLiveness = service.liveness();
      const initialState = initialLiveness.find((l) => l.peer.peerId === "a");
      expect(initialState?.status).toBe(PeerStatus.Alive);

      // Make unreachable and run a round
      transport.markUnreachable("a");
      await service.runRound();

      // Should be suspected
      const suspectedLiveness = service.liveness();
      const suspectedState = suspectedLiveness.find((l) => l.peer.peerId === "a");
      expect(suspectedState?.status).toBe(PeerStatus.Suspected);

      // Advance past failure timeout
      currentTime += 11000;
      await service.runRound();

      // After failure, peer is removed from view so liveness won't include it
      const failedLiveness = service.liveness();
      const failedState = failedLiveness.find((l) => l.peer.peerId === "a");
      expect(failedState).toBeUndefined();
    });
  });

  describe("suspected peer recovers", () => {
    it("emits peer_recovered when suspected peer responds again", async () => {
      const peerA = createPeer("a");
      const service = createService({
        peerId: "self",
        seedPeers: [peerA],
        transport,
        now,
        suspicionTimeoutMs: 5000,
        failureTimeoutMs: 15000,
      });

      const events = collectEvents(service);

      // First round succeeds
      await service.runRound();

      // Make unreachable
      transport.markUnreachable("a");
      await service.runRound();

      // Verify suspected
      const suspectedEvents = events.filter(
        (e) => e.type === GossipEventType.PeerSuspected && e.peerId === "a",
      );
      expect(suspectedEvents.length).toBeGreaterThanOrEqual(1);

      // Make reachable again
      transport.markReachable("a");
      await service.runRound();

      // Should have emitted peer_recovered
      const recovered = events.filter(
        (e) => e.type === GossipEventType.PeerRecovered && e.peerId === "a",
      );
      expect(recovered.length).toBeGreaterThanOrEqual(1);
    });

    it("peer is marked alive after recovery", async () => {
      const peerA = createPeer("a");
      const service = createService({
        peerId: "self",
        seedPeers: [peerA],
        transport,
        now,
        suspicionTimeoutMs: 5000,
        failureTimeoutMs: 15000,
      });

      // First round succeeds
      await service.runRound();

      // Make unreachable then back
      transport.markUnreachable("a");
      await service.runRound();

      transport.markReachable("a");
      await service.runRound();

      // Check liveness
      const livenessState = service.liveness().find((l) => l.peer.peerId === "a");
      expect(livenessState?.status).toBe(PeerStatus.Alive);
      expect(livenessState?.suspectedAt).toBeUndefined();
    });
  });

  describe("multiple simultaneous failures", () => {
    it("emits independent suspected events for each failing peer", async () => {
      const peerA = createPeer("a");
      const peerB = createPeer("b");
      const peerC = createPeer("c");

      const service = createService({
        peerId: "self",
        seedPeers: [peerA, peerB, peerC],
        transport,
        now,
        suspicionTimeoutMs: 5000,
        failureTimeoutMs: 15000,
      });

      const events = collectEvents(service);

      // First round: all peers succeed
      await service.runRound();

      // Make A and B unreachable simultaneously
      transport.markUnreachable("a");
      transport.markUnreachable("b");

      // Run rounds to trigger detection
      await service.runRound();

      const suspected = events.filter((e) => e.type === GossipEventType.PeerSuspected);
      const suspectedIds = new Set(suspected.map((e) => e.peerId));

      expect(suspectedIds.has("a")).toBe(true);
      expect(suspectedIds.has("b")).toBe(true);
      // Peer C should NOT be suspected
      expect(suspectedIds.has("c")).toBe(false);
    });

    it("emits independent failed events for each failing peer", async () => {
      const peerA = createPeer("a");
      const peerB = createPeer("b");
      const peerC = createPeer("c");

      const service = createService({
        peerId: "self",
        seedPeers: [peerA, peerB, peerC],
        transport,
        now,
        suspicionTimeoutMs: 5000,
        failureTimeoutMs: 15000,
      });

      const events = collectEvents(service);

      // First round succeeds
      await service.runRound();

      // Make A and B unreachable
      transport.markUnreachable("a");
      transport.markUnreachable("b");

      // Run round to suspect them
      await service.runRound();

      // Advance past failure timeout
      currentTime += 11000;
      await service.runRound();

      const failed = events.filter((e) => e.type === GossipEventType.PeerFailed);
      const failedIds = new Set(failed.map((e) => e.peerId));

      expect(failedIds.has("a")).toBe(true);
      expect(failedIds.has("b")).toBe(true);
      expect(failedIds.has("c")).toBe(false);

      // Both should be removed from view
      const peerIds = service.peers().map((p) => p.peerId);
      expect(peerIds).not.toContain("a");
      expect(peerIds).not.toContain("b");
      expect(peerIds).toContain("c");
    });

    it("one peer fails while another recovers", async () => {
      const peerA = createPeer("a");
      const peerB = createPeer("b");

      const service = createService({
        peerId: "self",
        seedPeers: [peerA, peerB],
        transport,
        now,
        suspicionTimeoutMs: 5000,
        failureTimeoutMs: 15000,
      });

      const events = collectEvents(service);

      // First round succeeds
      await service.runRound();

      // Both become unreachable
      transport.markUnreachable("a");
      transport.markUnreachable("b");
      await service.runRound();

      // Peer B recovers, peer A stays unreachable
      transport.markReachable("b");
      await service.runRound();

      // Advance past failure timeout for peer A
      currentTime += 11000;
      await service.runRound();

      // Peer A should be failed
      const failedEvents = events.filter(
        (e) => e.type === GossipEventType.PeerFailed && e.peerId === "a",
      );
      expect(failedEvents.length).toBeGreaterThanOrEqual(1);

      // Peer B should have recovered
      const recoveredEvents = events.filter(
        (e) => e.type === GossipEventType.PeerRecovered && e.peerId === "b",
      );
      expect(recoveredEvents.length).toBeGreaterThanOrEqual(1);

      // View should contain B but not A
      const peerIds = service.peers().map((p) => p.peerId);
      expect(peerIds).not.toContain("a");
      expect(peerIds).toContain("b");
    });
  });

  describe("gossip feeds reconciler integration", () => {
    it("calls reconcile function when a peer fails", async () => {
      const peerA = createPeer("a");
      const service = createService({
        peerId: "self",
        seedPeers: [peerA],
        transport,
        now,
        suspicionTimeoutMs: 5000,
        failureTimeoutMs: 15000,
      });

      const reconcileCalls: string[] = [];
      const mockReconcile = (peerId: string): void => {
        reconcileCalls.push(peerId);
      };

      // Register a listener that calls reconcile on peer_failed
      service.on((event) => {
        if (event.type === GossipEventType.PeerFailed) {
          mockReconcile(event.peerId);
        }
      });

      // First round succeeds
      await service.runRound();

      // Make peer unreachable
      transport.markUnreachable("a");
      await service.runRound();

      // Advance past failure timeout
      currentTime += 11000;
      await service.runRound();

      // Reconcile should have been called for peer A
      expect(reconcileCalls).toContain("a");
      expect(reconcileCalls.length).toBe(1);
    });

    it("calls reconcile for each failed peer independently", async () => {
      const peerA = createPeer("a");
      const peerB = createPeer("b");

      const service = createService({
        peerId: "self",
        seedPeers: [peerA, peerB],
        transport,
        now,
        suspicionTimeoutMs: 5000,
        failureTimeoutMs: 15000,
      });

      const reconcileCalls: string[] = [];
      service.on((event) => {
        if (event.type === GossipEventType.PeerFailed) {
          reconcileCalls.push(event.peerId);
        }
      });

      await service.runRound();

      transport.markUnreachable("a");
      transport.markUnreachable("b");
      await service.runRound();

      currentTime += 11000;
      await service.runRound();

      expect(reconcileCalls).toContain("a");
      expect(reconcileCalls).toContain("b");
      expect(reconcileCalls.length).toBe(2);
    });

    it("listener receives events with correct timestamps", async () => {
      const peerA = createPeer("a");
      const service = createService({
        peerId: "self",
        seedPeers: [peerA],
        transport,
        now,
        suspicionTimeoutMs: 5000,
        failureTimeoutMs: 15000,
      });

      const events = collectEvents(service);

      // Make unreachable from the start
      transport.markUnreachable("a");
      await service.runRound();

      // All events should have valid ISO timestamps
      for (const event of events) {
        const parsed = Date.parse(event.timestamp);
        expect(Number.isNaN(parsed)).toBe(false);
      }
    });

    it("removing a listener stops event delivery", async () => {
      const peerA = createPeer("a");
      const service = createService({
        peerId: "self",
        seedPeers: [peerA],
        transport,
        now,
        suspicionTimeoutMs: 5000,
        failureTimeoutMs: 15000,
      });

      const events: GossipEvent[] = [];
      const listener = (event: GossipEvent): void => {
        events.push(event);
      };

      service.on(listener);
      await service.runRound();

      const countAfterFirst = events.length;

      // Remove listener
      service.off(listener);

      // Make peer unreachable and run more rounds
      transport.markUnreachable("a");
      await service.runRound();
      currentTime += 11000;
      await service.runRound();

      // No new events should have been delivered
      expect(events.length).toBe(countAfterFirst);
    });
  });

  describe("timing edge cases", () => {
    it("peer is not suspected before suspicion timeout elapses", async () => {
      const peerA = createPeer("a");
      const service = createService({
        peerId: "self",
        seedPeers: [peerA],
        transport,
        now,
        suspicionTimeoutMs: 5000,
        failureTimeoutMs: 15000,
      });

      const events = collectEvents(service);

      // First round succeeds, establishing lastSeen
      await service.runRound();

      // Advance time slightly (not past suspicion timeout)
      currentTime += 3000;

      // Run round (no failure, just liveness check)
      await service.runRound();

      // No suspicion events should be emitted via liveness check
      const livenessSuspected = events.filter((e) => e.type === GossipEventType.PeerSuspected);
      // Only suspicion from markUnresponsive (direct transport failure) counts,
      // not from timeout-based liveness check
      expect(livenessSuspected.length).toBe(0);
    });

    it("suspected peer is not failed before failure timeout elapses", async () => {
      const peerA = createPeer("a");
      const service = createService({
        peerId: "self",
        seedPeers: [peerA],
        transport,
        now,
        suspicionTimeoutMs: 5000,
        failureTimeoutMs: 15000,
      });

      const events = collectEvents(service);

      await service.runRound();

      // Make unreachable
      transport.markUnreachable("a");
      await service.runRound();

      // Advance time but not past failure delta (10s)
      currentTime += 5000;
      await service.runRound();

      // Should have suspected but not failed
      const failed = events.filter((e) => e.type === GossipEventType.PeerFailed);
      expect(failed.length).toBe(0);

      const suspected = events.filter((e) => e.type === GossipEventType.PeerSuspected);
      expect(suspected.length).toBeGreaterThanOrEqual(1);
    });
  });
});
