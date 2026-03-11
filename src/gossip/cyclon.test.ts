import { describe, expect, test } from "bun:test";

import type { PeerInfo, ShuffleRequest } from "../core/gossip/types.js";
import { CyclonPeerSampler } from "./cyclon.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePeer(id: string, age = 0): PeerInfo {
  return {
    peerId: id,
    address: `http://${id}.example.com:4515`,
    age,
    lastSeen: new Date().toISOString(),
  };
}

const SELF = makePeer("self");

function defaultConfig(overrides?: { maxViewSize?: number; shuffleLength?: number }) {
  return {
    maxViewSize: overrides?.maxViewSize ?? 5,
    shuffleLength: overrides?.shuffleLength ?? 3,
  };
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe("CyclonPeerSampler constructor", () => {
  test("creates with empty initial peers", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig());
    expect(sampler.size).toBe(0);
    expect(sampler.getView()).toEqual([]);
  });

  test("creates with no initialPeers argument", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig());
    expect(sampler.size).toBe(0);
  });

  test("creates with initial peers", () => {
    const peers = [makePeer("a"), makePeer("b"), makePeer("c")];
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), peers);
    expect(sampler.size).toBe(3);
    expect(sampler.hasPeer("a")).toBe(true);
    expect(sampler.hasPeer("b")).toBe(true);
    expect(sampler.hasPeer("c")).toBe(true);
  });

  test("deduplicates initial peers", () => {
    const peers = [makePeer("a"), makePeer("b"), makePeer("a"), makePeer("b")];
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), peers);
    expect(sampler.size).toBe(2);
  });

  test("filters self from initial peers", () => {
    const peers = [makePeer("a"), makePeer(SELF.peerId), makePeer("b")];
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), peers);
    expect(sampler.size).toBe(2);
    expect(sampler.hasPeer(SELF.peerId)).toBe(false);
  });

  test("truncates initial peers to maxViewSize", () => {
    const peers = [
      makePeer("a"),
      makePeer("b"),
      makePeer("c"),
      makePeer("d"),
      makePeer("e"),
      makePeer("f"),
    ];
    const config = defaultConfig({ maxViewSize: 3 });
    const sampler = new CyclonPeerSampler(SELF, config, peers);
    expect(sampler.size).toBe(3);
  });

  test("deduplicates before truncating", () => {
    const peers = [makePeer("a"), makePeer("a"), makePeer("b"), makePeer("c"), makePeer("d")];
    const config = defaultConfig({ maxViewSize: 3 });
    const sampler = new CyclonPeerSampler(SELF, config, peers);
    // After dedup: a, b, c, d => truncated to 3
    expect(sampler.size).toBe(3);
    expect(sampler.hasPeer("a")).toBe(true);
    expect(sampler.hasPeer("b")).toBe(true);
    expect(sampler.hasPeer("c")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// addPeer
// ---------------------------------------------------------------------------

describe("addPeer", () => {
  test("adds a new peer and returns true", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig());
    const result = sampler.addPeer(makePeer("a"));
    expect(result).toBe(true);
    expect(sampler.size).toBe(1);
    expect(sampler.hasPeer("a")).toBe(true);
  });

  test("rejects self and returns false", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig());
    const result = sampler.addPeer(makePeer(SELF.peerId));
    expect(result).toBe(false);
    expect(sampler.size).toBe(0);
  });

  test("rejects duplicate and returns false", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [makePeer("a")]);
    const result = sampler.addPeer(makePeer("a"));
    expect(result).toBe(false);
    expect(sampler.size).toBe(1);
  });

  test("rejects when view is full and returns false", () => {
    const config = defaultConfig({ maxViewSize: 2 });
    const sampler = new CyclonPeerSampler(SELF, config, [makePeer("a"), makePeer("b")]);
    const result = sampler.addPeer(makePeer("c"));
    expect(result).toBe(false);
    expect(sampler.size).toBe(2);
    expect(sampler.hasPeer("c")).toBe(false);
  });

  test("returns boolean indicating success", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig());
    expect(typeof sampler.addPeer(makePeer("a"))).toBe("boolean");
    expect(typeof sampler.addPeer(makePeer("a"))).toBe("boolean"); // duplicate
  });
});

// ---------------------------------------------------------------------------
// removePeer
// ---------------------------------------------------------------------------

describe("removePeer", () => {
  test("removes an existing peer and returns true", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [makePeer("a"), makePeer("b")]);
    const result = sampler.removePeer("a");
    expect(result).toBe(true);
    expect(sampler.size).toBe(1);
    expect(sampler.hasPeer("a")).toBe(false);
  });

  test("returns false for non-existent peer", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [makePeer("a")]);
    const result = sampler.removePeer("nonexistent");
    expect(result).toBe(false);
    expect(sampler.size).toBe(1);
  });

  test("returns false when view is empty", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig());
    expect(sampler.removePeer("a")).toBe(false);
  });

  test("does not affect other peers", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [
      makePeer("a"),
      makePeer("b"),
      makePeer("c"),
    ]);
    sampler.removePeer("b");
    expect(sampler.hasPeer("a")).toBe(true);
    expect(sampler.hasPeer("c")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// selectOldestPeer
// ---------------------------------------------------------------------------

describe("selectOldestPeer", () => {
  test("returns undefined for empty view", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig());
    expect(sampler.selectOldestPeer()).toBeUndefined();
  });

  test("increments age of all entries", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [
      makePeer("a", 0),
      makePeer("b", 0),
    ]);
    sampler.selectOldestPeer();
    const view = sampler.getView();
    for (const peer of view) {
      expect(peer.age).toBe(1);
    }
  });

  test("returns oldest peer after aging", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [
      makePeer("a", 0),
      makePeer("b", 3),
      makePeer("c", 1),
    ]);
    // After aging: a=1, b=4, c=2 => oldest is b
    const oldest = sampler.selectOldestPeer();
    expect(oldest).toBeDefined();
    expect(oldest?.peerId).toBe("b");
    expect(oldest?.age).toBe(4);
  });

  test("ages accumulate across multiple calls", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [makePeer("a", 0)]);
    sampler.selectOldestPeer(); // age becomes 1
    sampler.selectOldestPeer(); // age becomes 2
    sampler.selectOldestPeer(); // age becomes 3
    const oldest = sampler.selectOldestPeer(); // age becomes 4
    expect(oldest?.age).toBe(4);
  });

  test("returns the single peer when view has one entry", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [makePeer("a", 5)]);
    const oldest = sampler.selectOldestPeer();
    expect(oldest?.peerId).toBe("a");
    expect(oldest?.age).toBe(6);
  });

  test("returns first oldest when there are ties", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [
      makePeer("a", 2),
      makePeer("b", 2),
    ]);
    // After aging: a=3, b=3, tied => returns first found (a)
    const oldest = sampler.selectOldestPeer();
    expect(oldest).toBeDefined();
    expect(oldest?.age).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// createShuffleRequest
// ---------------------------------------------------------------------------

describe("createShuffleRequest", () => {
  test("includes self with age 0 in offered", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [makePeer("a"), makePeer("b")]);
    const target = makePeer("a");
    const request = sampler.createShuffleRequest(target);

    expect(request.sender.peerId).toBe(SELF.peerId);
    expect(request.sender.age).toBe(0);
    // Self should also appear in offered
    const selfInOffered = request.offered.find((p) => p.peerId === SELF.peerId);
    expect(selfInOffered).toBeDefined();
    expect(selfInOffered?.age).toBe(0);
  });

  test("excludes target from offered entries", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig({ shuffleLength: 10 }), [
      makePeer("a"),
      makePeer("b"),
      makePeer("c"),
    ]);
    const target = makePeer("a");
    const request = sampler.createShuffleRequest(target);

    const targetInOffered = request.offered.find((p) => p.peerId === "a");
    expect(targetInOffered).toBeUndefined();
  });

  test("respects shuffleLength limit", () => {
    const config = defaultConfig({ shuffleLength: 2 });
    const sampler = new CyclonPeerSampler(SELF, config, [
      makePeer("a"),
      makePeer("b"),
      makePeer("c"),
      makePeer("d"),
    ]);
    const target = makePeer("a");
    const request = sampler.createShuffleRequest(target);

    // shuffleLength=2: self + 1 random entry from view (excluding target)
    expect(request.offered.length).toBeLessThanOrEqual(2);
  });

  test("offered includes self as first entry", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [makePeer("a"), makePeer("b")]);
    const request = sampler.createShuffleRequest(makePeer("a"));
    expect(request.offered[0]?.peerId).toBe(SELF.peerId);
  });

  test("works when view has only the target peer", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [makePeer("a")]);
    const request = sampler.createShuffleRequest(makePeer("a"));
    // Only self should be in offered since target is excluded from candidates
    expect(request.offered.length).toBe(1);
    expect(request.offered[0]?.peerId).toBe(SELF.peerId);
  });

  test("sender field is set to self with age 0", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [makePeer("a")]);
    const request = sampler.createShuffleRequest(makePeer("a"));
    expect(request.sender.peerId).toBe(SELF.peerId);
    expect(request.sender.age).toBe(0);
    expect(request.sender.address).toBe(SELF.address);
  });
});

// ---------------------------------------------------------------------------
// handleShuffleRequest
// ---------------------------------------------------------------------------

describe("handleShuffleRequest", () => {
  test("returns subset of own view", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [
      makePeer("a"),
      makePeer("b"),
      makePeer("c"),
    ]);
    const request: ShuffleRequest = {
      sender: makePeer("remote"),
      offered: [makePeer("remote", 0), makePeer("d", 1)],
    };
    const response = sampler.handleShuffleRequest(request);

    // Response offered should contain entries from our view
    expect(response.offered.length).toBeGreaterThan(0);
    expect(response.offered.length).toBeLessThanOrEqual(request.offered.length);
  });

  test("response excludes sender from offered", () => {
    const senderPeer = makePeer("remote");
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [
      makePeer("a"),
      senderPeer,
      makePeer("b"),
    ]);
    const request: ShuffleRequest = {
      sender: senderPeer,
      offered: [makePeer("remote", 0), makePeer("d", 1)],
    };
    const response = sampler.handleShuffleRequest(request);

    const senderInResponse = response.offered.find((p) => p.peerId === "remote");
    expect(senderInResponse).toBeUndefined();
  });

  test("response excludes offered peer IDs", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [
      makePeer("a"),
      makePeer("b"),
      makePeer("c"),
    ]);
    const request: ShuffleRequest = {
      sender: makePeer("remote"),
      offered: [makePeer("remote", 0), makePeer("a", 1)],
    };
    const response = sampler.handleShuffleRequest(request);

    // "a" was in offered, so should not appear in response
    const aInResponse = response.offered.find((p) => p.peerId === "a");
    expect(aInResponse).toBeUndefined();
  });

  test("merges received entries into view", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig({ maxViewSize: 10 }), [
      makePeer("a"),
    ]);
    const request: ShuffleRequest = {
      sender: makePeer("remote"),
      offered: [makePeer("remote", 0), makePeer("d", 1)],
    };
    sampler.handleShuffleRequest(request);

    // "remote" and "d" should now be in view (or replaced existing entries)
    expect(sampler.hasPeer("d")).toBe(true);
    expect(sampler.hasPeer("remote")).toBe(true);
  });

  test("does not add self to view from received entries", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [makePeer("a")]);
    const request: ShuffleRequest = {
      sender: makePeer("remote"),
      offered: [makePeer(SELF.peerId, 0), makePeer("d", 1)],
    };
    sampler.handleShuffleRequest(request);
    expect(sampler.hasPeer(SELF.peerId)).toBe(false);
  });

  test("respects maxViewSize when merging", () => {
    const config = defaultConfig({ maxViewSize: 3 });
    const sampler = new CyclonPeerSampler(SELF, config, [
      makePeer("a", 0),
      makePeer("b", 0),
      makePeer("c", 0),
    ]);
    const request: ShuffleRequest = {
      sender: makePeer("remote"),
      offered: [makePeer("remote", 0), makePeer("d", 0), makePeer("e", 0)],
    };
    sampler.handleShuffleRequest(request);

    // View should not exceed maxViewSize
    expect(sampler.size).toBeLessThanOrEqual(config.maxViewSize);
  });
});

// ---------------------------------------------------------------------------
// processShuffleResponse
// ---------------------------------------------------------------------------

describe("processShuffleResponse", () => {
  test("merges received entries into view", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig({ maxViewSize: 10 }), [
      makePeer("a"),
      makePeer("b"),
    ]);
    const sentEntries = [makePeer("a")];
    sampler.processShuffleResponse({ offered: [makePeer("c", 0)] }, sentEntries);

    expect(sampler.hasPeer("c")).toBe(true);
  });

  test("replaces sent entries with received entries", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig({ maxViewSize: 5 }), [
      makePeer("a"),
      makePeer("b"),
      makePeer("c"),
    ]);
    const sentEntries = [makePeer("a"), makePeer("b")];
    sampler.processShuffleResponse({ offered: [makePeer("x", 0), makePeer("y", 0)] }, sentEntries);

    // x and y should have replaced a and b
    expect(sampler.hasPeer("x")).toBe(true);
    expect(sampler.hasPeer("y")).toBe(true);
  });

  test("updates existing entries if received entry is fresher (lower age)", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [
      makePeer("a", 5),
      makePeer("b", 3),
    ]);
    sampler.processShuffleResponse({ offered: [makePeer("a", 1)] }, []);

    const view = sampler.getView();
    const entryA = view.find((p) => p.peerId === "a");
    expect(entryA).toBeDefined();
    expect(entryA?.age).toBe(1); // updated to fresher age
  });

  test("does not update existing entries if received entry is older (higher age)", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [
      makePeer("a", 2),
      makePeer("b", 3),
    ]);
    sampler.processShuffleResponse({ offered: [makePeer("a", 10)] }, []);

    const view = sampler.getView();
    const entryA = view.find((p) => p.peerId === "a");
    expect(entryA).toBeDefined();
    expect(entryA?.age).toBe(2); // kept original age
  });

  test("does not add self from received entries", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [makePeer("a")]);
    sampler.processShuffleResponse({ offered: [makePeer(SELF.peerId, 0)] }, []);
    expect(sampler.hasPeer(SELF.peerId)).toBe(false);
  });

  test("replaces oldest entry when view is full and received entry is fresher", () => {
    const config = defaultConfig({ maxViewSize: 3 });
    const sampler = new CyclonPeerSampler(SELF, config, [
      makePeer("a", 10),
      makePeer("b", 1),
      makePeer("c", 1),
    ]);
    // View is full, no sent entries to replace, so it should replace oldest (a) if fresher
    sampler.processShuffleResponse({ offered: [makePeer("d", 0)] }, []);

    expect(sampler.hasPeer("d")).toBe(true);
    expect(sampler.size).toBe(3);
  });

  test("does not replace oldest when received entry is not fresher", () => {
    const config = defaultConfig({ maxViewSize: 3 });
    const sampler = new CyclonPeerSampler(SELF, config, [
      makePeer("a", 2),
      makePeer("b", 1),
      makePeer("c", 1),
    ]);
    // Received entry age=5 is older than the oldest in view (a, age=2)
    sampler.processShuffleResponse({ offered: [makePeer("d", 5)] }, []);

    expect(sampler.hasPeer("d")).toBe(false);
    expect(sampler.size).toBe(3);
  });

  test("handles empty response", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [makePeer("a")]);
    sampler.processShuffleResponse({ offered: [] }, []);
    expect(sampler.size).toBe(1);
    expect(sampler.hasPeer("a")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasPeer
// ---------------------------------------------------------------------------

describe("hasPeer", () => {
  test("returns true for existing peer", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [makePeer("a")]);
    expect(sampler.hasPeer("a")).toBe(true);
  });

  test("returns false for non-existent peer", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [makePeer("a")]);
    expect(sampler.hasPeer("b")).toBe(false);
  });

  test("returns false for self peerId", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig());
    expect(sampler.hasPeer(SELF.peerId)).toBe(false);
  });

  test("returns false after peer is removed", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [makePeer("a")]);
    sampler.removePeer("a");
    expect(sampler.hasPeer("a")).toBe(false);
  });

  test("returns true after peer is added", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig());
    sampler.addPeer(makePeer("a"));
    expect(sampler.hasPeer("a")).toBe(true);
  });

  test("returns false on empty view", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig());
    expect(sampler.hasPeer("anything")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getView
// ---------------------------------------------------------------------------

describe("getView", () => {
  test("returns a snapshot of the current view", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig(), [makePeer("a"), makePeer("b")]);
    const view = sampler.getView();
    expect(view.length).toBe(2);
  });

  test("reflects changes after addPeer", () => {
    const sampler = new CyclonPeerSampler(SELF, defaultConfig());
    sampler.addPeer(makePeer("a"));
    const view = sampler.getView();
    expect(view.length).toBe(1);
    expect(view[0]?.peerId).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// Integration: full shuffle round
// ---------------------------------------------------------------------------

describe("full shuffle round integration", () => {
  test("two samplers can complete a full shuffle exchange", () => {
    const selfA = makePeer("node-A");
    const selfB = makePeer("node-B");
    const config = defaultConfig({ maxViewSize: 5, shuffleLength: 3 });

    const samplerA = new CyclonPeerSampler(selfA, config, [
      makePeer("node-B"),
      makePeer("p1"),
      makePeer("p2"),
    ]);
    const samplerB = new CyclonPeerSampler(selfB, config, [
      makePeer("node-A"),
      makePeer("p3"),
      makePeer("p4"),
    ]);

    // Node A selects oldest peer and creates shuffle request
    const target = samplerA.selectOldestPeer();
    expect(target).toBeDefined();

    // Assume target is node-B
    const targetPeer = makePeer("node-B");
    const request = samplerA.createShuffleRequest(targetPeer);

    expect(request.sender.peerId).toBe("node-A");
    expect(request.offered.length).toBeGreaterThan(0);

    // Node B handles the shuffle request
    const response = samplerB.handleShuffleRequest(request);
    expect(response.offered.length).toBeGreaterThan(0);

    // Node A processes the response
    samplerA.processShuffleResponse(response, request.offered);

    // Both samplers should still have valid view sizes
    expect(samplerA.size).toBeLessThanOrEqual(config.maxViewSize);
    expect(samplerB.size).toBeLessThanOrEqual(config.maxViewSize);

    // Node B should now know about node A (from the shuffle request sender)
    expect(samplerB.hasPeer("node-A")).toBe(true);
  });

  test("multiple shuffle rounds converge views", () => {
    const config = defaultConfig({ maxViewSize: 10, shuffleLength: 3 });

    const nodes = ["n1", "n2", "n3", "n4", "n5"].map((id) => makePeer(id));
    const samplers = nodes.map(
      (self) =>
        new CyclonPeerSampler(
          self,
          config,
          // Each node initially knows only its neighbor
          [nodes[(nodes.indexOf(self) + 1) % nodes.length] ?? self],
        ),
    );

    // Run several rounds of shuffles
    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < samplers.length; i++) {
        const sampler = samplers[i];
        if (!sampler) continue;
        const oldest = sampler.selectOldestPeer();
        if (!oldest) continue;

        // Find the target sampler
        const targetIdx = nodes.findIndex((n) => n.peerId === oldest.peerId);
        if (targetIdx < 0) continue;

        const request = sampler.createShuffleRequest(oldest);
        const targetSampler = samplers[targetIdx];
        if (!targetSampler) continue;
        const response = targetSampler.handleShuffleRequest(request);
        sampler.processShuffleResponse(response, request.offered);
      }
    }

    // After multiple rounds, each node should know about multiple peers
    for (const sampler of samplers) {
      expect(sampler.size).toBeGreaterThan(0);
      expect(sampler.size).toBeLessThanOrEqual(config.maxViewSize);
    }
  });
});
