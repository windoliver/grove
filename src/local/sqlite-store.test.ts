/**
 * Tests for SqliteStore using conformance test suites.
 *
 * Creates a fresh SQLite database in a temp directory for each test,
 * and tears it down after.
 *
 * Tests the legacy SqliteStore (combined), SqliteContributionStore,
 * and SqliteClaimStore independently.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaimStoreTests } from "../core/claim-store.conformance.js";
import { ContributionKind, RelationType } from "../core/models.js";
import { runContributionStoreTests } from "../core/store.conformance.js";
import type { ContributionStore } from "../core/store.js";
import { makeContribution } from "../core/test-helpers.js";
import { createSqliteStores, SqliteStore } from "./sqlite-store.js";

// ---------------------------------------------------------------------------
// Legacy SqliteStore — ContributionStore conformance
// ---------------------------------------------------------------------------

runContributionStoreTests(async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlite-store-contrib-"));
  const dbPath = join(dir, "test.db");
  const store = new SqliteStore(dbPath);

  return {
    store,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
});

// ---------------------------------------------------------------------------
// Legacy SqliteStore — ClaimStore conformance
// ---------------------------------------------------------------------------

runClaimStoreTests(async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlite-store-claim-"));
  const dbPath = join(dir, "test.db");
  const store = new SqliteStore(dbPath);

  return {
    store,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
});

// ---------------------------------------------------------------------------
// Split stores — ContributionStore conformance
// ---------------------------------------------------------------------------

runContributionStoreTests(async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlite-split-contrib-"));
  const dbPath = join(dir, "test.db");
  const { contributionStore, close } = createSqliteStores(dbPath);

  return {
    store: contributionStore,
    cleanup: async () => {
      close();
      await rm(dir, { recursive: true, force: true });
    },
  };
});

// ---------------------------------------------------------------------------
// Split stores — ClaimStore conformance
// ---------------------------------------------------------------------------

runClaimStoreTests(async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlite-split-claim-"));
  const dbPath = join(dir, "test.db");
  const { claimStore, close } = createSqliteStores(dbPath);

  return {
    store: claimStore,
    cleanup: async () => {
      close();
      await rm(dir, { recursive: true, force: true });
    },
  };
});

// ---------------------------------------------------------------------------
// putMany with rich contributions (relations, tags, artifacts)
// ---------------------------------------------------------------------------

describe("putMany with rich contributions", () => {
  let store: ContributionStore;
  let dir: string;
  let closeStore: () => void;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sqlite-putmany-rich-"));
    const dbPath = join(dir, "test.db");
    const stores = createSqliteStores(dbPath);
    store = stores.contributionStore;
    closeStore = stores.close;
  });

  afterEach(async () => {
    store.close();
    closeStore();
    await rm(dir, { recursive: true, force: true });
  });

  test("putMany with relations populates children and ancestors", async () => {
    // Create 2 root contributions (no relations)
    const root1 = makeContribution({
      summary: "root-1",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const root2 = makeContribution({
      summary: "root-2",
      createdAt: "2026-01-01T01:00:00Z",
    });
    await store.putMany([root1, root2]);

    // Create 5 contributions with relations pointing to the roots
    const c1 = makeContribution({
      summary: "child-1",
      createdAt: "2026-01-02T00:00:00Z",
      relations: [
        { targetCid: root1.cid, relationType: RelationType.DerivesFrom },
        { targetCid: root2.cid, relationType: RelationType.RespondsTo },
      ],
    });
    const c2 = makeContribution({
      summary: "child-2",
      createdAt: "2026-01-02T01:00:00Z",
      relations: [{ targetCid: root1.cid, relationType: RelationType.DerivesFrom }],
    });
    const c3 = makeContribution({
      summary: "child-3",
      createdAt: "2026-01-02T02:00:00Z",
      relations: [
        { targetCid: root1.cid, relationType: RelationType.Reviews },
        { targetCid: root2.cid, relationType: RelationType.DerivesFrom },
      ],
    });
    const c4 = makeContribution({
      summary: "child-4",
      createdAt: "2026-01-02T03:00:00Z",
      relations: [
        { targetCid: root2.cid, relationType: RelationType.RespondsTo },
        { targetCid: root1.cid, relationType: RelationType.DerivesFrom },
        { targetCid: root2.cid, relationType: RelationType.Reviews },
      ],
    });
    const c5 = makeContribution({
      summary: "child-5",
      createdAt: "2026-01-02T04:00:00Z",
      relations: [{ targetCid: root2.cid, relationType: RelationType.DerivesFrom }],
    });

    await store.putMany([c1, c2, c3, c4, c5]);

    // children of root1: c1, c2, c3, c4 (all have at least one relation to root1)
    const root1Children = await store.children(root1.cid);
    const root1ChildCids = root1Children.map((c) => c.cid);
    expect(root1ChildCids).toContain(c1.cid);
    expect(root1ChildCids).toContain(c2.cid);
    expect(root1ChildCids).toContain(c3.cid);
    expect(root1ChildCids).toContain(c4.cid);
    expect(root1ChildCids).not.toContain(c5.cid);

    // children of root2: c1, c3, c4, c5
    const root2Children = await store.children(root2.cid);
    const root2ChildCids = root2Children.map((c) => c.cid);
    expect(root2ChildCids).toContain(c1.cid);
    expect(root2ChildCids).toContain(c3.cid);
    expect(root2ChildCids).toContain(c4.cid);
    expect(root2ChildCids).toContain(c5.cid);
    expect(root2ChildCids).not.toContain(c2.cid);

    // ancestors of c1: root1, root2
    const c1Ancestors = await store.ancestors(c1.cid);
    const c1AncestorCids = c1Ancestors.map((c) => c.cid);
    expect(c1AncestorCids).toContain(root1.cid);
    expect(c1AncestorCids).toContain(root2.cid);

    // ancestors of c4: root1, root2
    const c4Ancestors = await store.ancestors(c4.cid);
    const c4AncestorCids = c4Ancestors.map((c) => c.cid);
    expect(c4AncestorCids).toContain(root1.cid);
    expect(c4AncestorCids).toContain(root2.cid);
  });

  test("putMany with tags supports tag-filtered list (intersection)", async () => {
    const c1 = makeContribution({
      summary: "tagged-1",
      tags: ["ml", "python", "gpu"],
      createdAt: "2026-02-01T00:00:00Z",
    });
    const c2 = makeContribution({
      summary: "tagged-2",
      tags: ["ml", "rust", "cpu", "benchmark"],
      createdAt: "2026-02-01T01:00:00Z",
    });
    const c3 = makeContribution({
      summary: "tagged-3",
      tags: ["python", "gpu", "benchmark"],
      createdAt: "2026-02-01T02:00:00Z",
    });
    const c4 = makeContribution({
      summary: "tagged-4",
      tags: ["ml", "python", "gpu", "benchmark", "training"],
      createdAt: "2026-02-01T03:00:00Z",
    });
    const c5 = makeContribution({
      summary: "tagged-5",
      tags: ["rust", "cpu", "inference"],
      createdAt: "2026-02-01T04:00:00Z",
    });

    await store.putMany([c1, c2, c3, c4, c5]);

    // Filter by ["ml", "python"] — intersection: c1, c4
    const mlPython = await store.list({ tags: ["ml", "python"] });
    const mlPythonCids = mlPython.map((c) => c.cid);
    expect(mlPythonCids.length).toBe(2);
    expect(mlPythonCids).toContain(c1.cid);
    expect(mlPythonCids).toContain(c4.cid);

    // Filter by ["gpu", "benchmark"] — intersection: c3, c4
    const gpuBench = await store.list({ tags: ["gpu", "benchmark"] });
    const gpuBenchCids = gpuBench.map((c) => c.cid);
    expect(gpuBenchCids.length).toBe(2);
    expect(gpuBenchCids).toContain(c3.cid);
    expect(gpuBenchCids).toContain(c4.cid);

    // Filter by ["rust"] — c2, c5
    const rustOnly = await store.list({ tags: ["rust"] });
    const rustCids = rustOnly.map((c) => c.cid);
    expect(rustCids.length).toBe(2);
    expect(rustCids).toContain(c2.cid);
    expect(rustCids).toContain(c5.cid);
  });

  test("putMany with artifacts populates artifacts junction table", async () => {
    const c1 = makeContribution({
      summary: "artifact-1",
      artifacts: {
        "model.bin": "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "config.json": "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      createdAt: "2026-03-01T00:00:00Z",
    });
    const c2 = makeContribution({
      summary: "artifact-2",
      artifacts: {
        "weights.pt": "blake3:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        "log.txt": "blake3:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      },
      createdAt: "2026-03-01T01:00:00Z",
    });
    const c3 = makeContribution({
      summary: "artifact-3",
      artifacts: {
        "output.csv": "blake3:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "metrics.json": "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "plot.png": "blake3:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      },
      createdAt: "2026-03-01T02:00:00Z",
    });

    await store.putMany([c1, c2, c3]);

    // Verify retrieval preserves artifacts
    const stored1 = await store.get(c1.cid);
    expect(stored1).toBeDefined();
    expect(Object.keys(stored1?.artifacts ?? {}).length).toBe(2);
    expect(stored1?.artifacts["model.bin"]).toBe(
      "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(stored1?.artifacts["config.json"]).toBe(
      "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );

    const stored3 = await store.get(c3.cid);
    expect(stored3).toBeDefined();
    expect(Object.keys(stored3?.artifacts ?? {}).length).toBe(3);
    expect(stored3?.artifacts["metrics.json"]).toBe(
      "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  test("putMany mixed: relations, tags, artifacts, and FTS all work", async () => {
    // Create root contributions
    const root1 = makeContribution({
      summary: "foundation model training run",
      createdAt: "2026-04-01T00:00:00Z",
    });
    const root2 = makeContribution({
      summary: "baseline benchmark evaluation",
      createdAt: "2026-04-01T01:00:00Z",
    });
    await store.putMany([root1, root2]);

    // Create 10 contributions with a mix of relations, tags, and artifacts
    const contributions = [
      makeContribution({
        summary: "improved transformer architecture",
        tags: ["ml", "architecture"],
        relations: [{ targetCid: root1.cid, relationType: RelationType.DerivesFrom }],
        artifacts: {
          "model.bin": "blake3:1111111111111111111111111111111111111111111111111111111111111111",
        },
        createdAt: "2026-04-02T00:00:00Z",
      }),
      makeContribution({
        summary: "hyperparameter sweep results",
        tags: ["ml", "tuning", "experiment"],
        relations: [{ targetCid: root1.cid, relationType: RelationType.DerivesFrom }],
        createdAt: "2026-04-02T01:00:00Z",
      }),
      makeContribution({
        summary: "code review of transformer changes",
        kind: ContributionKind.Review,
        tags: ["review"],
        relations: [{ targetCid: root1.cid, relationType: RelationType.Reviews }],
        createdAt: "2026-04-02T02:00:00Z",
      }),
      makeContribution({
        summary: "benchmark reproduction on GPU cluster",
        tags: ["benchmark", "gpu"],
        relations: [{ targetCid: root2.cid, relationType: RelationType.DerivesFrom }],
        artifacts: {
          "results.csv": "blake3:2222222222222222222222222222222222222222222222222222222222222222",
        },
        createdAt: "2026-04-02T03:00:00Z",
      }),
      makeContribution({
        summary: "discussion about training stability",
        kind: ContributionKind.Discussion,
        tags: ["discussion", "ml"],
        relations: [{ targetCid: root1.cid, relationType: RelationType.RespondsTo }],
        createdAt: "2026-04-02T04:00:00Z",
      }),
      makeContribution({
        summary: "optimized data pipeline implementation",
        tags: ["ml", "data", "performance"],
        relations: [
          { targetCid: root1.cid, relationType: RelationType.DerivesFrom },
          { targetCid: root2.cid, relationType: RelationType.DerivesFrom },
        ],
        createdAt: "2026-04-02T05:00:00Z",
      }),
      makeContribution({
        summary: "inference latency benchmark",
        tags: ["benchmark", "inference"],
        relations: [{ targetCid: root2.cid, relationType: RelationType.DerivesFrom }],
        artifacts: {
          "latency.json": "blake3:3333333333333333333333333333333333333333333333333333333333333333",
          "profile.txt": "blake3:4444444444444444444444444444444444444444444444444444444444444444",
        },
        createdAt: "2026-04-02T06:00:00Z",
      }),
      makeContribution({
        summary: "standalone analysis contribution",
        tags: ["analysis"],
        createdAt: "2026-04-02T07:00:00Z",
      }),
      makeContribution({
        summary: "review of benchmark methodology",
        kind: ContributionKind.Review,
        tags: ["review", "benchmark"],
        relations: [{ targetCid: root2.cid, relationType: RelationType.Reviews }],
        createdAt: "2026-04-02T08:00:00Z",
      }),
      makeContribution({
        summary: "distributed training experiment",
        tags: ["ml", "distributed", "experiment"],
        relations: [{ targetCid: root1.cid, relationType: RelationType.DerivesFrom }],
        artifacts: {
          "checkpoint.pt":
            "blake3:5555555555555555555555555555555555555555555555555555555555555555",
        },
        createdAt: "2026-04-02T09:00:00Z",
      }),
    ];

    await store.putMany(contributions);

    // All 12 contributions stored
    const all = await store.list();
    expect(all.length).toBe(12);

    // Tag filter: ["ml", "experiment"] — contributions[1] and contributions[9]
    const mlExperiment = await store.list({ tags: ["ml", "experiment"] });
    expect(mlExperiment.length).toBe(2);
    const mlExpCids = mlExperiment.map((c) => c.cid);
    expect(mlExpCids).toContain(contributions[1]?.cid);
    expect(mlExpCids).toContain(contributions[9]?.cid);

    // Relations: children of root1
    const root1Children = await store.children(root1.cid);
    expect(root1Children.length).toBeGreaterThanOrEqual(5);

    // Relations: children of root2
    const root2Children = await store.children(root2.cid);
    expect(root2Children.length).toBeGreaterThanOrEqual(3);

    // FTS search
    const transformerSearch = await store.search("transformer");
    expect(transformerSearch.length).toBeGreaterThanOrEqual(1);
    expect(transformerSearch.map((c) => c.cid)).toContain(contributions[0]?.cid);

    // FTS with filter
    const reviewSearch = await store.search("benchmark", { kind: ContributionKind.Review });
    expect(reviewSearch.length).toBe(1);
    expect(reviewSearch[0]?.cid).toBe(contributions[8]?.cid);

    // Artifacts preserved
    const latencyContrib = await store.get(contributions[6]?.cid ?? "");
    expect(latencyContrib).toBeDefined();
    expect(Object.keys(latencyContrib?.artifacts ?? {}).length).toBe(2);
  });

  test("putMany with duplicates does not create duplicate junction rows", async () => {
    const root = makeContribution({
      summary: "duplicate-root",
      createdAt: "2026-05-01T00:00:00Z",
    });
    await store.put(root);

    const contributions = [
      makeContribution({
        summary: "dup-1",
        tags: ["alpha", "beta"],
        relations: [{ targetCid: root.cid, relationType: RelationType.DerivesFrom }],
        artifacts: {
          "file.txt": "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        createdAt: "2026-05-02T00:00:00Z",
      }),
      makeContribution({
        summary: "dup-2",
        tags: ["gamma"],
        relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
        createdAt: "2026-05-02T01:00:00Z",
      }),
      makeContribution({
        summary: "dup-3",
        tags: ["alpha", "gamma", "delta"],
        relations: [
          { targetCid: root.cid, relationType: RelationType.DerivesFrom },
          { targetCid: root.cid, relationType: RelationType.Reviews },
        ],
        artifacts: {
          "data.csv": "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "report.md": "blake3:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        },
        createdAt: "2026-05-02T02:00:00Z",
      }),
      makeContribution({
        summary: "dup-4",
        tags: ["beta"],
        createdAt: "2026-05-02T03:00:00Z",
      }),
      makeContribution({
        summary: "dup-5",
        tags: ["alpha"],
        relations: [{ targetCid: root.cid, relationType: RelationType.DerivesFrom }],
        createdAt: "2026-05-02T04:00:00Z",
      }),
    ];

    // Insert once
    await store.putMany(contributions);

    // Insert again (idempotent)
    await store.putMany(contributions);

    // Verify counts: 6 total (root + 5)
    const all = await store.list();
    expect(all.length).toBe(6);

    // Children of root should not have duplicates
    const rootChildren = await store.children(root.cid);
    const childCids = rootChildren.map((c) => c.cid);
    const uniqueChildCids = [...new Set(childCids)];
    expect(childCids.length).toBe(uniqueChildCids.length);
    // contributions[0], contributions[1], contributions[2], contributions[4] have relations to root
    expect(uniqueChildCids.length).toBe(4);

    // relationsOf should not have duplicates
    const c2Rels = await store.relationsOf(contributions[2]?.cid ?? "");
    expect(c2Rels.length).toBe(2); // derives_from + reviews, no duplicates

    // Tag-filtered list should not produce duplicate contributions
    const alphaTagged = await store.list({ tags: ["alpha"] });
    const alphaCids = alphaTagged.map((c) => c.cid);
    const uniqueAlphaCids = [...new Set(alphaCids)];
    expect(alphaCids.length).toBe(uniqueAlphaCids.length);
    // contributions[0], contributions[2], contributions[4] have "alpha" tag
    expect(uniqueAlphaCids.length).toBe(3);

    // Search should not return duplicates
    const searchResults = await store.search("dup");
    const searchCids = searchResults.map((c) => c.cid);
    const uniqueSearchCids = [...new Set(searchCids)];
    expect(searchCids.length).toBe(uniqueSearchCids.length);
    expect(uniqueSearchCids.length).toBe(5);
  });
});
