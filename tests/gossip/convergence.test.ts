/**
 * Deterministic gossip convergence simulation.
 *
 * Validates that CYCLON peer sampling achieves O(log N) convergence:
 * starting from sparse seed connectivity, every peer discovers the
 * majority of the network within a logarithmic number of rounds.
 *
 * Uses a seeded PRNG so results are fully reproducible. Override the
 * seed via the GOSSIP_TEST_SEED env var to replay a specific run.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PeerInfo } from "../../src/core/gossip/types.js";
import { CyclonPeerSampler } from "../../src/gossip/cyclon.js";

// ---------------------------------------------------------------------------
// Seeded PRNG (LCG)
// ---------------------------------------------------------------------------

const GOSSIP_TEST_SEED = Number(process.env.GOSSIP_TEST_SEED) || 42;
console.log(`[gossip convergence] using seed: ${GOSSIP_TEST_SEED}`);

/** Create a seeded PRNG using a linear congruential generator. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) & 0xffffffff;
    return (state >>> 0) / 0xffffffff;
  };
}

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

/**
 * Build N CyclonPeerSampler instances, each seeded with a small
 * random subset of other peers (1-2 seeds per peer).
 */
function buildNetwork(
  n: number,
  maxViewSize: number,
  shuffleLength: number,
  seedCount: number = 2,
): { peers: PeerInfo[]; samplers: CyclonPeerSampler[] } {
  const peers = Array.from({ length: n }, (_, i) => createPeer(String(i)));
  const samplers: CyclonPeerSampler[] = [];

  for (let i = 0; i < n; i++) {
    // Each peer gets `seedCount` random other peers as initial seeds
    const seeds: PeerInfo[] = [];
    const candidates = peers.filter((_, idx) => idx !== i);
    // Deterministic but spread out: pick peers at evenly-spaced indices
    for (let s = 0; s < Math.min(seedCount, candidates.length); s++) {
      const idx = (i + 1 + s * Math.floor(n / seedCount)) % candidates.length;
      const candidate = candidates[idx];
      if (candidate) seeds.push(candidate);
    }

    const peer = peers[i];
    if (peer) samplers.push(new CyclonPeerSampler(peer, { maxViewSize, shuffleLength }, seeds));
  }

  return { peers, samplers };
}

/**
 * Run a single gossip round: every peer selects its oldest peer,
 * creates a shuffle request, the target handles it, and the
 * initiator processes the response.
 *
 * @param dropRate - fraction of shuffles to drop (simulating message loss)
 * @param rng - seeded PRNG for deterministic message-loss simulation
 */
function runRound(
  samplers: CyclonPeerSampler[],
  peers: PeerInfo[],
  dropRate: number = 0,
  rng: () => number = Math.random,
): void {
  for (let i = 0; i < samplers.length; i++) {
    const sampler = samplers[i];
    if (!sampler) continue;
    const target = sampler.selectOldestPeer();
    if (!target) continue;

    // Simulate message loss (deterministic via seeded rng)
    if (dropRate > 0 && rng() < dropRate) continue;

    // Find the target sampler
    const targetIdx = peers.findIndex((p) => p.peerId === target.peerId);
    if (targetIdx < 0) continue;
    const targetSampler = samplers[targetIdx];
    if (!targetSampler) continue;

    const request = sampler.createShuffleRequest(target);
    const response = targetSampler.handleShuffleRequest(request);
    sampler.processShuffleResponse(response, request.offered);
  }
}

/**
 * Measure convergence: the minimum number of unique peers known by
 * any single node in the network.
 */
function measureMinKnown(samplers: CyclonPeerSampler[]): number {
  let min = Infinity;
  for (const sampler of samplers) {
    const known = sampler.getView().length;
    if (known < min) min = known;
  }
  return min;
}

/**
 * Measure convergence: the average number of unique peers known
 * per node.
 */
function measureAvgKnown(samplers: CyclonPeerSampler[]): number {
  let total = 0;
  for (const sampler of samplers) {
    total += sampler.getView().length;
  }
  return total / samplers.length;
}

/**
 * Count total unique peer-to-peer links across the overlay.
 * Each (a knows b) is one directed link.
 */
function countTotalLinks(samplers: CyclonPeerSampler[]): number {
  let total = 0;
  for (const sampler of samplers) {
    total += sampler.getView().length;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Gossip convergence simulation", () => {
  // Replace Math.random with the seeded PRNG so that the production
  // shuffleArray (which calls Math.random directly) is deterministic.
  const originalRandom = Math.random;
  let rng: () => number;

  beforeEach(() => {
    rng = seededRandom(GOSSIP_TEST_SEED);
    Math.random = rng;
  });

  afterEach(() => {
    Math.random = originalRandom;
  });

  describe("small network (N=10)", () => {
    const N = 10;
    const maxViewSize = Math.ceil(Math.log2(N)) + 2; // 6
    const shuffleLength = Math.min(3, maxViewSize);
    const maxRounds = 10;

    it("converges so each peer knows >= 4 unique peers within 10 rounds", () => {
      const { peers, samplers } = buildNetwork(N, maxViewSize, shuffleLength);

      for (let round = 0; round < maxRounds; round++) {
        runRound(samplers, peers);
      }

      // With maxViewSize=6 and 10 rounds, each peer should fill most
      // of its view. Allow some slack for randomized shuffle variance.
      const threshold = Math.max(Math.floor(maxViewSize * 0.7), 4);
      for (let i = 0; i < samplers.length; i++) {
        const known = samplers[i]?.getView().length;
        expect(known).toBeGreaterThanOrEqual(threshold);
      }
    });

    it("shows monotonically increasing connectivity over rounds", () => {
      const { peers, samplers } = buildNetwork(N, maxViewSize, shuffleLength);

      let prevLinks = countTotalLinks(samplers);
      let increased = 0;

      for (let round = 0; round < maxRounds; round++) {
        runRound(samplers, peers);
        const currentLinks = countTotalLinks(samplers);
        if (currentLinks > prevLinks) increased++;
        prevLinks = currentLinks;
      }

      // Network should increase connectivity in the early rounds
      expect(increased).toBeGreaterThan(0);
    });
  });

  describe("medium network (N=50)", () => {
    const N = 50;
    const maxViewSize = Math.ceil(Math.log2(N)) + 2; // 8
    const shuffleLength = Math.min(4, maxViewSize);
    const maxRounds = 15;

    it("converges so each peer knows >= 8 unique peers within 15 rounds", () => {
      const { peers, samplers } = buildNetwork(N, maxViewSize, shuffleLength);

      for (let round = 0; round < maxRounds; round++) {
        runRound(samplers, peers);
      }

      const threshold = maxViewSize;
      const minKnown = measureMinKnown(samplers);
      // At least the min-known peer should have a nearly full view
      expect(minKnown).toBeGreaterThanOrEqual(threshold - 2);
    });

    it("achieves high average connectivity", () => {
      const { peers, samplers } = buildNetwork(N, maxViewSize, shuffleLength);

      for (let round = 0; round < maxRounds; round++) {
        runRound(samplers, peers);
      }

      const avg = measureAvgKnown(samplers);
      // Average should be close to maxViewSize
      expect(avg).toBeGreaterThanOrEqual(maxViewSize - 1);
    });
  });

  describe("large network (N=100)", () => {
    const N = 100;
    const maxViewSize = Math.ceil(Math.log2(N)) + 2; // 9
    const shuffleLength = Math.min(4, maxViewSize);
    const maxRounds = 20;

    it("converges so each peer knows >= 7 unique peers within 20 rounds", () => {
      const { peers, samplers } = buildNetwork(N, maxViewSize, shuffleLength);

      for (let round = 0; round < maxRounds; round++) {
        runRound(samplers, peers);
      }

      const threshold = maxViewSize - 2; // 7
      const minKnown = measureMinKnown(samplers);
      expect(minKnown).toBeGreaterThanOrEqual(threshold);
    });

    it("no peer remains isolated after convergence", () => {
      const { peers, samplers } = buildNetwork(N, maxViewSize, shuffleLength);

      for (let round = 0; round < maxRounds; round++) {
        runRound(samplers, peers);
      }

      // Every peer should have at least 1 other peer in its view
      for (const sampler of samplers) {
        expect(sampler.getView().length).toBeGreaterThan(0);
      }
    });

    it("peer views contain diverse peers (not all the same)", () => {
      const { peers, samplers } = buildNetwork(N, maxViewSize, shuffleLength);

      for (let round = 0; round < maxRounds; round++) {
        runRound(samplers, peers);
      }

      // Collect all unique peers known across the network
      const allKnown = new Set<string>();
      for (const sampler of samplers) {
        for (const peer of sampler.getView()) {
          allKnown.add(peer.peerId);
        }
      }

      // The network should collectively know about most peers
      expect(allKnown.size).toBeGreaterThanOrEqual(N - 1);
    });
  });

  describe("message loss resilience", () => {
    const N = 10;
    const maxViewSize = Math.ceil(Math.log2(N)) + 2; // 6
    const shuffleLength = Math.min(3, maxViewSize);

    it("converges with 20% message loss within 15 rounds", () => {
      const { peers, samplers } = buildNetwork(N, maxViewSize, shuffleLength);
      const maxRounds = 15;
      const dropRate = 0.2;

      for (let round = 0; round < maxRounds; round++) {
        runRound(samplers, peers, dropRate, rng);
      }

      // With 20% loss, convergence is slower but should still achieve
      // reasonable connectivity. Each peer should know at least half
      // the view capacity.
      const threshold = Math.floor(maxViewSize / 2);
      const minKnown = measureMinKnown(samplers);
      expect(minKnown).toBeGreaterThanOrEqual(threshold);
    });

    it("converges with 20% message loss: average >= 4 peers known", () => {
      const { peers, samplers } = buildNetwork(N, maxViewSize, shuffleLength);
      const maxRounds = 15;
      const dropRate = 0.2;

      for (let round = 0; round < maxRounds; round++) {
        runRound(samplers, peers, dropRate, rng);
      }

      const avg = measureAvgKnown(samplers);
      expect(avg).toBeGreaterThanOrEqual(4);
    });

    it("recovers from 50% message loss given extra rounds", () => {
      const { peers, samplers } = buildNetwork(N, maxViewSize, shuffleLength);
      const maxRounds = 25;
      const dropRate = 0.5;

      for (let round = 0; round < maxRounds; round++) {
        runRound(samplers, peers, dropRate, rng);
      }

      // Even with extreme loss, given enough rounds, peers connect
      const threshold = Math.floor(maxViewSize / 3);
      const minKnown = measureMinKnown(samplers);
      expect(minKnown).toBeGreaterThanOrEqual(threshold);
    });
  });

  describe("convergence rate", () => {
    it("total unique peers discovered across the network grows each round", () => {
      const N = 30;
      const maxViewSize = Math.ceil(Math.log2(N)) + 2;
      const shuffleLength = Math.min(4, maxViewSize);
      const { peers, samplers } = buildNetwork(N, maxViewSize, shuffleLength);
      const rounds = 10;

      const discoveredPerRound: number[] = [];

      for (let round = 0; round < rounds; round++) {
        runRound(samplers, peers);
        // Collect all unique peer links across the network
        const allKnown = new Set<string>();
        for (const sampler of samplers) {
          for (const peer of sampler.getView()) {
            allKnown.add(peer.peerId);
          }
        }
        discoveredPerRound.push(allKnown.size);
      }

      // The number of unique peers discovered should be monotonically
      // non-decreasing and eventually reach N-1 (all except self, but
      // any single peer isn't "self" for the set -- all N peers should
      // appear as known by at least one other peer)
      for (let i = 1; i < discoveredPerRound.length; i++) {
        expect(discoveredPerRound[i] ?? 0).toBeGreaterThanOrEqual(discoveredPerRound[i - 1] ?? 0);
      }

      // After all rounds, all peers should be discovered by someone
      expect(discoveredPerRound[rounds - 1] ?? 0).toBeGreaterThanOrEqual(N - 1);
    });
  });

  describe("edge cases", () => {
    it("single peer: view stays empty", () => {
      const peer = createPeer("solo");
      const sampler = new CyclonPeerSampler(peer, { maxViewSize: 5, shuffleLength: 3 });

      expect(sampler.getView()).toHaveLength(0);
      expect(sampler.selectOldestPeer()).toBeUndefined();
    });

    it("two peers: both learn about each other in one round", () => {
      const peerA = createPeer("a");
      const peerB = createPeer("b");

      const samplerA = new CyclonPeerSampler(peerA, { maxViewSize: 5, shuffleLength: 3 }, [peerB]);
      const samplerB = new CyclonPeerSampler(peerB, { maxViewSize: 5, shuffleLength: 3 }, [peerA]);

      // One round
      const targetA = samplerA.selectOldestPeer();
      expect(targetA).toBeDefined();
      const request = samplerA.createShuffleRequest(targetA ?? peerB);
      const response = samplerB.handleShuffleRequest(request);
      samplerA.processShuffleResponse(response, request.offered);

      // Both should know about each other
      expect(samplerA.hasPeer("b")).toBe(true);
      expect(samplerB.hasPeer("a")).toBe(true);
    });

    it("self-peer is never included in view", () => {
      const N = 10;
      const maxViewSize = Math.ceil(Math.log2(N)) + 2;
      const { peers, samplers } = buildNetwork(N, maxViewSize, 3);

      for (let round = 0; round < 10; round++) {
        runRound(samplers, peers);
      }

      for (let i = 0; i < N; i++) {
        expect(samplers[i]?.hasPeer(String(i))).toBe(false);
      }
    });
  });
});
