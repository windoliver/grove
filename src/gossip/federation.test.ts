import { describe, it, expect } from "bun:test";
import { hash as blake3Hash } from "blake3";
import { FederationFetcher, runAntiEntropySweep } from "./federation.js";
import type { FrontierDigestEntry, GossipTransport, PeerInfo } from "../core/gossip/types.js";
import type { ContentStore } from "../core/cas.js";
import type { ContributionStore } from "../core/store.js";
import { createContribution } from "../core/manifest.js";
import type { Contribution } from "../core/models.js";

function makeContribution(opts: {
  artifacts?: Record<string, string>;
  summary?: string;
}): Contribution {
  return createContribution({
    kind: "work",
    mode: "evaluation",
    summary: opts.summary ?? "fed-test",
    artifacts: opts.artifacts ?? {},
    relations: [],
    tags: [],
    agent: { agentId: "agent-test", agentName: "agent-test", platform: "test" },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

function makePeer(id: string): PeerInfo {
  return { peerId: id, address: `http://${id}:1`, age: 0, lastSeen: new Date().toISOString() };
}

function blake3Of(bytes: Uint8Array): string {
  return `blake3:${blake3Hash(bytes).toString("hex")}`;
}

class StubTransport implements GossipTransport {
  constructor(
    private readonly manifest: Contribution | undefined,
    private readonly blobs: Map<string, Uint8Array> = new Map(),
  ) {}
  exchange = async () => ({}) as never;
  shuffle = async () => ({}) as never;
  fetchContribution = async () => this.manifest;
  // Stub: federation now fetches by (cid, artifactName), but the manifest
  // in these tests carries declared hashes. Look up the hash via the
  // manifest the StubTransport already holds.
  fetchArtifact = async (_p: PeerInfo, _cid: string, name: string) => {
    const declared = this.manifest?.artifacts?.[name];
    if (!declared) return undefined;
    return this.blobs.get(declared);
  };
}

class MemContributionStore implements Pick<ContributionStore, "get" | "put"> {
  readonly map = new Map<string, Contribution>();
  async get(cid: string) {
    return this.map.get(cid);
  }
  async put(c: Contribution) {
    this.map.set(c.cid, c);
    return { kind: "stored" as const, contribution: c };
  }
}

class MemCas implements Pick<ContentStore, "put" | "exists" | "get" | "delete"> {
  readonly map = new Map<string, Uint8Array>();
  async put(b: Uint8Array) {
    const h = blake3Of(b);
    this.map.set(h, b);
    return h;
  }
  async exists(h: string) {
    return this.map.has(h);
  }
  async get(h: string) {
    return this.map.get(h);
  }
  async delete(h: string) {
    return this.map.delete(h);
  }
}

describe("FederationFetcher.fetchRemoteContribution", () => {
  it("returns already-local when the cid exists locally", async () => {
    const sample = makeContribution({ summary: "already-here" });
    const store = new MemContributionStore();
    store.map.set(sample.cid, sample);
    const fetcher = new FederationFetcher({
      contributionStore: store as unknown as ContributionStore,
      cas: new MemCas() as unknown as ContentStore,
      transport: new StubTransport(undefined),
      peersFor: () => [],
    });
    const result = await fetcher.fetchRemoteContribution(sample.cid);
    expect(result.kind).toBe("already-local");
  });

  it("returns no-source when no peer has advertised the cid", async () => {
    const fetcher = new FederationFetcher({
      contributionStore: new MemContributionStore() as unknown as ContributionStore,
      cas: new MemCas() as unknown as ContentStore,
      transport: new StubTransport(undefined),
      peersFor: () => [],
    });
    const result = await fetcher.fetchRemoteContribution(`blake3:${"1".repeat(64)}`);
    expect(result.kind).toBe("no-source");
  });

  it("fetches manifest + artifacts and verifies BLAKE3 before storing", async () => {
    const artifactBytes = new Uint8Array([1, 2, 3]);
    const artifactHash = blake3Of(artifactBytes);
    const manifest = makeContribution({
      summary: "remote",
      artifacts: { "out.txt": artifactHash },
    });
    const cas = new MemCas();
    const contribs = new MemContributionStore();
    const fetcher = new FederationFetcher({
      contributionStore: contribs as unknown as ContributionStore,
      cas: cas as unknown as ContentStore,
      transport: new StubTransport(manifest, new Map([[artifactHash, artifactBytes]])),
      peersFor: () => [makePeer("A")],
    });
    const result = await fetcher.fetchRemoteContribution(manifest.cid);
    expect(result.kind).toBe("ok");
    expect(contribs.map.has(manifest.cid)).toBe(true);
    expect(cas.map.has(artifactHash)).toBe(true);
  });

  it("rejects a manifest whose canonical CID does not match the advertised CID", async () => {
    // The peer claims a CID but returns a manifest that hashes to something
    // else — fromManifest({verify:true}) catches this before any artifact
    // side effects.
    const realManifest = makeContribution({ summary: "real" });
    const fakeCid = `blake3:${"f".repeat(64)}`;
    const fetcher = new FederationFetcher({
      contributionStore: new MemContributionStore() as unknown as ContributionStore,
      cas: new MemCas() as unknown as ContentStore,
      transport: new StubTransport(realManifest),
      peersFor: () => [makePeer("A")],
    });
    const result = await fetcher.fetchRemoteContribution(fakeCid);
    expect(result.kind).toBe("failed");
  });

  it("rejects an artifact whose bytes do not match the manifest hash", async () => {
    const bogus = new Uint8Array([9, 9, 9]);
    // Build a valid manifest with a hash field that points at non-matching bytes.
    const declared = `blake3:${"0".repeat(64)}`; // does not match `bogus`
    const manifest = makeContribution({
      summary: "x",
      artifacts: { "out.txt": declared },
    });
    const fetcher = new FederationFetcher({
      contributionStore: new MemContributionStore() as unknown as ContributionStore,
      cas: new MemCas() as unknown as ContentStore,
      transport: new StubTransport(manifest, new Map([[declared, bogus]])),
      peersFor: () => [makePeer("A")],
    });
    const result = await fetcher.fetchRemoteContribution(manifest.cid);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toMatch(/hash mismatch/i);
  });

  it("rejects manifests that declare more artifacts than the per-fetch cap", async () => {
    const artifacts: Record<string, string> = {};
    for (let i = 0; i < 200; i++) {
      artifacts[`a${i}`] = `blake3:${i.toString(16).padStart(64, "0")}`;
    }
    const manifest = makeContribution({ artifacts });
    const fetcher = new FederationFetcher({
      contributionStore: new MemContributionStore() as unknown as ContributionStore,
      cas: new MemCas() as unknown as ContentStore,
      transport: new StubTransport(manifest),
      peersFor: () => [makePeer("A")],
    });
    const result = await fetcher.fetchRemoteContribution(manifest.cid);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toMatch(/artifacts > cap/);
  });

  it("returns failed if the store accepts put but get(cid) still 404s afterwards", async () => {
    // Simulates a content-hash dedup store: put() succeeds (silently dedupes
    // against an existing logical-content row under a different CID), but
    // get(cid) for the requested CID never resolves. Without the post-put
    // verification, federation would lie ("ok") and anti-entropy would
    // refetch indefinitely.
    const artifactBytes = new Uint8Array([42]);
    const artifactHash = blake3Of(artifactBytes);
    const manifest = makeContribution({
      summary: "dedup-test",
      artifacts: { a: artifactHash },
    });
    const dedupStore: Pick<ContributionStore, "get" | "put"> = {
      async get() {
        return undefined; // never finds the CID, even after put
      },
      async put() {
        return undefined; // accepts but doesn't actually store under this CID
      },
    };
    const fetcher = new FederationFetcher({
      contributionStore: dedupStore as unknown as ContributionStore,
      cas: new MemCas() as unknown as ContentStore,
      transport: new StubTransport(manifest, new Map([[artifactHash, artifactBytes]])),
      peersFor: () => [makePeer("A")],
    });
    const result = await fetcher.fetchRemoteContribution(manifest.cid);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toMatch(/not present after put|deduped/i);
  });

  it("falls back to next peer when the first errors", async () => {
    const artifactBytes = new Uint8Array([7]);
    const artifactHash = blake3Of(artifactBytes);
    const manifest = makeContribution({ summary: "x", artifacts: { a: artifactHash } });
    let calls = 0;
    const flakyTransport: GossipTransport = {
      exchange: async () => ({}) as never,
      shuffle: async () => ({}) as never,
      fetchContribution: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return manifest;
      },
      fetchArtifact: async (_p, _c, _n) => artifactBytes,
    };
    const contribs = new MemContributionStore();
    const fetcher = new FederationFetcher({
      contributionStore: contribs as unknown as ContributionStore,
      cas: new MemCas() as unknown as ContentStore,
      transport: flakyTransport,
      peersFor: () => [makePeer("A"), makePeer("B")],
    });
    const result = await fetcher.fetchRemoteContribution(manifest.cid);
    expect(result.kind).toBe("ok");
    expect(calls).toBe(2);
  });
});

describe("runAntiEntropySweep", () => {
  it("fetches frontier entries whose value meets the threshold and skips local cids", async () => {
    const fetched: string[] = [];
    const fakeFetcher = {
      fetchRemoteContribution: async (cid: string) => {
        fetched.push(cid);
        return { kind: "ok", cid } as const;
      },
    };
    const frontier: FrontierDigestEntry[] = [
      { metric: "tests_passed", value: 9, cid: "blake3:" + "a".repeat(64) },
      { metric: "tests_passed", value: 1, cid: "blake3:" + "b".repeat(64) }, // below threshold
      { metric: "_recency", value: 1, cid: "blake3:" + "c".repeat(64) },
    ];
    await runAntiEntropySweep({
      frontier,
      fetcher: fakeFetcher as unknown as FederationFetcher,
      batchSize: 4,
      thresholds: { tests_passed: 5 },
    });
    expect(fetched.sort()).toEqual(
      ["blake3:" + "a".repeat(64), "blake3:" + "c".repeat(64)].sort(),
    );
  });

  it("respects batchSize", async () => {
    let count = 0;
    const fakeFetcher = {
      fetchRemoteContribution: async (cid: string) => {
        count += 1;
        return { kind: "ok", cid } as const;
      },
    };
    const frontier: FrontierDigestEntry[] = Array.from({ length: 5 }, (_, i) => ({
      metric: "m",
      value: 10,
      cid: `blake3:${String(i).repeat(64).slice(0, 64)}`,
    }));
    await runAntiEntropySweep({
      frontier,
      fetcher: fakeFetcher as unknown as FederationFetcher,
      batchSize: 2,
      thresholds: {},
    });
    expect(count).toBe(2);
  });
});
