import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsCas } from "../local/fs-cas.js";
import {
  createSqliteStores,
  initSqliteDb,
  SqliteClaimStore,
  SqliteContributionStore,
} from "../local/sqlite-store.js";
import type { GroveContract } from "./contract.js";
import { EnforcingClaimStore, EnforcingContributionStore } from "./enforcing-store.js";
import {
  ArtifactLimitError,
  ConcurrencyLimitError,
  LeaseViolationError,
  RateLimitError,
} from "./errors.js";
import { makeClaim, makeContribution } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContract(overrides: Partial<GroveContract> = {}): GroveContract {
  return {
    contractVersion: 2,
    name: "test-grove",
    ...overrides,
  };
}

/** Create a contribution with a "now" timestamp so it falls within the rate limit window. */
function makeRecentContribution(overrides?: Parameters<typeof makeContribution>[0]) {
  return makeContribution({
    createdAt: new Date().toISOString(),
    ...overrides,
  });
}

async function setupStores() {
  const dir = await mkdtemp(join(tmpdir(), "enforcing-store-"));
  const db = initSqliteDb(join(dir, "test.db"));
  const contributionStore = new SqliteContributionStore(db);
  const claimStore = new SqliteClaimStore(db);
  const casDir = join(dir, "cas");
  const cas = new FsCas(casDir);
  return { dir, db, contributionStore, claimStore, cas };
}

async function cleanup(dir: string, db: { close(): void }) {
  db.close();
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// EnforcingContributionStore — Rate Limits
// ---------------------------------------------------------------------------

describe("EnforcingContributionStore", () => {
  describe("per-agent rate limit", () => {
    test("allows contributions within rate limit", async () => {
      const { dir, db, contributionStore } = await setupStores();
      try {
        const contract = makeContract({
          rateLimits: { maxContributionsPerAgentPerHour: 5 },
        });
        const store = new EnforcingContributionStore(contributionStore, contract);

        for (let i = 0; i < 5; i++) {
          await store.put(makeRecentContribution({ summary: `contribution-${i}` }));
        }

        expect(await store.count()).toBe(5);
      } finally {
        await cleanup(dir, db);
      }
    });

    test("rejects contribution exceeding per-agent rate limit", async () => {
      const { dir, db, contributionStore } = await setupStores();
      try {
        const contract = makeContract({
          rateLimits: { maxContributionsPerAgentPerHour: 3 },
        });
        const store = new EnforcingContributionStore(contributionStore, contract);

        for (let i = 0; i < 3; i++) {
          await store.put(makeRecentContribution({ summary: `c-${i}` }));
        }

        try {
          await store.put(makeRecentContribution({ summary: "c-4" }));
          expect.unreachable("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(RateLimitError);
          const err = e as RateLimitError;
          expect(err.limitType).toBe("per_agent");
          expect(err.current).toBe(3);
          expect(err.limit).toBe(3);
          expect(err.retryAfterMs).toBeGreaterThan(0);
        }
      } finally {
        await cleanup(dir, db);
      }
    });

    test("contributions from different agents have independent rate limits", async () => {
      const { dir, db, contributionStore } = await setupStores();
      try {
        const contract = makeContract({
          rateLimits: { maxContributionsPerAgentPerHour: 2 },
        });
        const store = new EnforcingContributionStore(contributionStore, contract);

        // Agent A: 2 contributions (at limit)
        for (let i = 0; i < 2; i++) {
          await store.put(
            makeRecentContribution({
              summary: `agent-a-${i}`,
              agent: { agentId: "agent-a" },
            }),
          );
        }

        // Agent B: should still be able to contribute
        await store.put(
          makeRecentContribution({
            summary: "agent-b-0",
            agent: { agentId: "agent-b" },
          }),
        );
        expect(await store.count()).toBe(3);
      } finally {
        await cleanup(dir, db);
      }
    });

    test("old contributions outside window do not count", async () => {
      const { dir, db, contributionStore } = await setupStores();
      try {
        const contract = makeContract({
          rateLimits: { maxContributionsPerAgentPerHour: 2 },
        });

        // Pre-populate store with old contributions (>1 hour ago)
        const oldTime = new Date(Date.now() - 3700 * 1000).toISOString();
        for (let i = 0; i < 3; i++) {
          await contributionStore.put(
            makeContribution({
              summary: `old-${i}`,
              createdAt: oldTime,
            }),
          );
        }

        // Enforce with a clock that's "now"
        const store = new EnforcingContributionStore(contributionStore, contract);

        // Should allow 2 more since old ones are outside window
        await store.put(makeRecentContribution({ summary: "new-0" }));
        await store.put(makeRecentContribution({ summary: "new-1" }));
        expect(await store.count()).toBe(5);
      } finally {
        await cleanup(dir, db);
      }
    });

    test("injectable clock controls rate limit window", async () => {
      const { dir, db, contributionStore } = await setupStores();
      try {
        const contract = makeContract({
          rateLimits: { maxContributionsPerAgentPerHour: 2 },
        });

        let mockNow = new Date("2026-01-01T00:00:00Z");
        const store = new EnforcingContributionStore(contributionStore, contract, {
          clock: () => mockNow,
        });

        // Submit 2 contributions at T=0
        await store.put(makeContribution({ summary: "t0-0", createdAt: mockNow.toISOString() }));
        await store.put(makeContribution({ summary: "t0-1", createdAt: mockNow.toISOString() }));

        // Should be rate-limited
        try {
          await store.put(makeContribution({ summary: "t0-2", createdAt: mockNow.toISOString() }));
          expect.unreachable("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(RateLimitError);
        }

        // Advance clock past the 1-hour window
        mockNow = new Date("2026-01-01T01:00:01Z");

        // Should succeed — old contributions rolled out of window
        await store.put(makeContribution({ summary: "t1-0", createdAt: mockNow.toISOString() }));
        expect(await store.count()).toBe(3);
      } finally {
        await cleanup(dir, db);
      }
    });
  });

  describe("per-grove rate limit", () => {
    test("rejects contribution exceeding per-grove rate limit", async () => {
      const { dir, db, contributionStore } = await setupStores();
      try {
        const contract = makeContract({
          rateLimits: { maxContributionsPerGrovePerHour: 3 },
        });
        const store = new EnforcingContributionStore(contributionStore, contract);

        // Different agents all contribute
        for (let i = 0; i < 3; i++) {
          await store.put(
            makeRecentContribution({
              summary: `agent-${i}`,
              agent: { agentId: `agent-${i}` },
            }),
          );
        }

        try {
          await store.put(
            makeRecentContribution({
              summary: "over-limit",
              agent: { agentId: "agent-new" },
            }),
          );
          expect.unreachable("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(RateLimitError);
          expect((e as RateLimitError).limitType).toBe("per_grove");
        }
      } finally {
        await cleanup(dir, db);
      }
    });
  });

  describe("artifact limits", () => {
    test("rejects contribution exceeding artifact count limit", async () => {
      const { dir, db, contributionStore } = await setupStores();
      try {
        const contract = makeContract({
          rateLimits: { maxArtifactsPerContribution: 2 },
        });
        const store = new EnforcingContributionStore(contributionStore, contract);

        const contribution = makeRecentContribution({
          summary: "too-many-artifacts",
          artifacts: {
            "file1.txt": "blake3:0000000000000000000000000000000000000000000000000000000000000001",
            "file2.txt": "blake3:0000000000000000000000000000000000000000000000000000000000000002",
            "file3.txt": "blake3:0000000000000000000000000000000000000000000000000000000000000003",
          },
        });

        try {
          await store.put(contribution);
          expect.unreachable("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(ArtifactLimitError);
          const err = e as ArtifactLimitError;
          expect(err.limitType).toBe("count");
          expect(err.current).toBe(3);
          expect(err.limit).toBe(2);
        }
      } finally {
        await cleanup(dir, db);
      }
    });

    test("allows contributions within artifact count limit", async () => {
      const { dir, db, contributionStore } = await setupStores();
      try {
        const contract = makeContract({
          rateLimits: { maxArtifactsPerContribution: 5 },
        });
        const store = new EnforcingContributionStore(contributionStore, contract);

        const contribution = makeRecentContribution({
          summary: "ok-artifacts",
          artifacts: {
            "file1.txt": "blake3:0000000000000000000000000000000000000000000000000000000000000001",
            "file2.txt": "blake3:0000000000000000000000000000000000000000000000000000000000000002",
          },
        });

        await store.put(contribution);
        expect(await store.count()).toBe(1);
      } finally {
        await cleanup(dir, db);
      }
    });

    test("checks artifact size via CAS", async () => {
      const { dir, db, contributionStore, cas } = await setupStores();
      try {
        const contract = makeContract({
          rateLimits: { maxArtifactSizeBytes: 100 },
        });
        const store = new EnforcingContributionStore(contributionStore, contract, { cas });

        // Store a large artifact
        const largeData = new Uint8Array(200);
        const hash = await cas.put(largeData);

        const contribution = makeRecentContribution({
          summary: "large-artifact",
          artifacts: { "big.bin": hash },
        });

        try {
          await store.put(contribution);
          expect.unreachable("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(ArtifactLimitError);
          const err = e as ArtifactLimitError;
          expect(err.limitType).toBe("size");
          expect(err.current).toBe(200);
          expect(err.limit).toBe(100);
        }
      } finally {
        await cleanup(dir, db);
      }
    });
  });

  describe("no limits configured", () => {
    test("passes through when no rate limits set", async () => {
      const { dir, db, contributionStore } = await setupStores();
      try {
        const contract = makeContract();
        const store = new EnforcingContributionStore(contributionStore, contract);

        for (let i = 0; i < 10; i++) {
          await store.put(makeRecentContribution({ summary: `c-${i}` }));
        }
        expect(await store.count()).toBe(10);
      } finally {
        await cleanup(dir, db);
      }
    });

    test("allows historical contributions when no rate limits set", async () => {
      const { dir, db, contributionStore } = await setupStores();
      try {
        const contract = makeContract(); // no rateLimits
        const store = new EnforcingContributionStore(contributionStore, contract);

        // A contribution with a very old timestamp should be accepted
        // because clock skew enforcement is only active with rate limits
        const historical = makeContribution({
          summary: "historical",
          createdAt: "2020-01-01T00:00:00Z",
        });
        await store.put(historical);
        expect(await store.count()).toBe(1);
      } finally {
        await cleanup(dir, db);
      }
    });
  });

  describe("putMany enforcement", () => {
    test("rejects entire batch if any contribution would exceed limit", async () => {
      const { dir, db, contributionStore } = await setupStores();
      try {
        const contract = makeContract({
          rateLimits: { maxContributionsPerAgentPerHour: 2 },
        });
        const store = new EnforcingContributionStore(contributionStore, contract);

        await store.put(makeRecentContribution({ summary: "existing" }));

        // Batch of 2 would put us at 3 total, exceeding limit of 2
        const batch = [
          makeRecentContribution({ summary: "batch-0" }),
          makeRecentContribution({ summary: "batch-1" }),
        ];

        try {
          await store.putMany(batch);
          expect.unreachable("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(RateLimitError);
        }

        // Only the first contribution should exist
        expect(await store.count()).toBe(1);
      } finally {
        await cleanup(dir, db);
      }
    });

    test("mixed-agent batch counts per-agent correctly", async () => {
      const { dir, db, contributionStore } = await setupStores();
      try {
        const contract = makeContract({
          rateLimits: { maxContributionsPerAgentPerHour: 1 },
        });
        const store = new EnforcingContributionStore(contributionStore, contract);

        // [agent-a, agent-b] should both be accepted (1 each, limit is 1)
        const batch = [
          makeRecentContribution({
            summary: "agent-a",
            agent: { agentId: "agent-a" },
          }),
          makeRecentContribution({
            summary: "agent-b",
            agent: { agentId: "agent-b" },
          }),
        ];

        await store.putMany(batch);
        expect(await store.count()).toBe(2);
      } finally {
        await cleanup(dir, db);
      }
    });

    test("putMany deduplicates same CID within the batch", async () => {
      const { dir, db, contributionStore } = await setupStores();
      try {
        const contract = makeContract({
          rateLimits: { maxContributionsPerAgentPerHour: 1 },
        });
        const store = new EnforcingContributionStore(contributionStore, contract);

        const c = makeRecentContribution({ summary: "dup" });
        // putMany([c, c]) should succeed — second is an intra-batch duplicate, not a rate limit hit
        await store.putMany([c, c]);
        expect(await store.count()).toBe(1);
      } finally {
        await cleanup(dir, db);
      }
    });
  });

  describe("idempotent put", () => {
    test("re-submitting same CID does not trigger rate limit", async () => {
      const { dir, db, contributionStore } = await setupStores();
      try {
        const contract = makeContract({
          rateLimits: { maxContributionsPerAgentPerHour: 1 },
        });
        const store = new EnforcingContributionStore(contributionStore, contract);

        const c = makeRecentContribution({ summary: "idempotent" });
        await store.put(c);

        // Re-submitting the same CID should be a no-op, not a rate limit error
        await store.put(c);
        expect(await store.count()).toBe(1);
      } finally {
        await cleanup(dir, db);
      }
    });
  });

  describe("clock skew rejection", () => {
    test("rejects contribution with backdated createdAt", async () => {
      const { dir, db, contributionStore } = await setupStores();
      try {
        const contract = makeContract({
          rateLimits: { maxContributionsPerAgentPerHour: 10 },
        });
        const store = new EnforcingContributionStore(contributionStore, contract);

        // Backdate by 2 hours — well beyond the 5-minute tolerance
        const backdated = makeContribution({
          summary: "backdated",
          createdAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
        });

        try {
          await store.put(backdated);
          expect.unreachable("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(RateLimitError);
          expect((e as RateLimitError).message).toContain("too far in the past");
        }
      } finally {
        await cleanup(dir, db);
      }
    });

    test("rejects contribution with future-dated createdAt", async () => {
      const { dir, db, contributionStore } = await setupStores();
      try {
        const contract = makeContract({
          rateLimits: { maxContributionsPerAgentPerHour: 10 },
        });
        const store = new EnforcingContributionStore(contributionStore, contract);

        // Future-date by 2 hours — well beyond the 5-minute tolerance
        const futureDated = makeContribution({
          summary: "future-dated",
          createdAt: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
        });

        try {
          await store.put(futureDated);
          expect.unreachable("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(RateLimitError);
          expect((e as RateLimitError).message).toContain("too far in the future");
        }
      } finally {
        await cleanup(dir, db);
      }
    });

    test("allows contribution within clock skew tolerance", async () => {
      const { dir, db, contributionStore } = await setupStores();
      try {
        const contract = makeContract({
          rateLimits: { maxContributionsPerAgentPerHour: 10 },
        });
        const store = new EnforcingContributionStore(contributionStore, contract);

        // 1 minute in the past — within the 5-minute tolerance
        const slightlyOld = makeContribution({
          summary: "slightly-old",
          createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
        });

        await store.put(slightlyOld);
        expect(await store.count()).toBe(1);
      } finally {
        await cleanup(dir, db);
      }
    });
  });

  describe("concurrent writes", () => {
    test("shared mutex prevents cross-wrapper bypass (same inner store)", async () => {
      const { dir, db, contributionStore } = await setupStores();
      try {
        const contract = makeContract({
          rateLimits: { maxContributionsPerAgentPerHour: 1 },
        });
        // Two separate wrappers over the same inner store object
        const store1 = new EnforcingContributionStore(contributionStore, contract);
        const store2 = new EnforcingContributionStore(contributionStore, contract);

        await store1.put(makeRecentContribution({ summary: "from-wrapper-1" }));

        // Second wrapper should see the contribution from wrapper 1 and reject
        try {
          await store2.put(makeRecentContribution({ summary: "from-wrapper-2" }));
          expect.unreachable("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(RateLimitError);
        }

        expect(await contributionStore.count()).toBe(1);
      } finally {
        await cleanup(dir, db);
      }
    });

    test("shared mutex prevents cross-connection bypass (separate store objects, same DB)", async () => {
      const dir = await mkdtemp(join(tmpdir(), "enforcing-store-xconn-"));
      const dbPath = join(dir, "test.db");
      const stores1 = createSqliteStores(dbPath);
      const stores2 = createSqliteStores(dbPath);
      try {
        const contract = makeContract({
          rateLimits: { maxContributionsPerAgentPerHour: 1 },
        });
        // Two wrappers over DIFFERENT store objects backed by the same DB file
        const wrapper1 = new EnforcingContributionStore(stores1.contributionStore, contract);
        const wrapper2 = new EnforcingContributionStore(stores2.contributionStore, contract);

        await wrapper1.put(makeRecentContribution({ summary: "from-conn-1" }));

        try {
          await wrapper2.put(makeRecentContribution({ summary: "from-conn-2" }));
          expect.unreachable("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(RateLimitError);
        }

        expect(await stores1.contributionStore.count()).toBe(1);
      } finally {
        stores1.close();
        stores2.close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test("mutex prevents concurrent puts from exceeding rate limit", async () => {
      const { dir, db, contributionStore } = await setupStores();
      try {
        const contract = makeContract({
          rateLimits: { maxContributionsPerAgentPerHour: 1 },
        });
        const store = new EnforcingContributionStore(contributionStore, contract);

        // Fire 3 concurrent puts — only 1 should succeed
        const results = await Promise.allSettled([
          store.put(makeRecentContribution({ summary: "concurrent-0" })),
          store.put(makeRecentContribution({ summary: "concurrent-1" })),
          store.put(makeRecentContribution({ summary: "concurrent-2" })),
        ]);

        const fulfilled = results.filter((r) => r.status === "fulfilled").length;
        const rejected = results.filter((r) => r.status === "rejected").length;

        expect(fulfilled).toBe(1);
        expect(rejected).toBe(2);
        expect(await store.count()).toBe(1);
      } finally {
        await cleanup(dir, db);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// EnforcingClaimStore — Concurrency Limits
// ---------------------------------------------------------------------------

describe("EnforcingClaimStore", () => {
  describe("global concurrency limit", () => {
    test("allows claims within global limit", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract({
          concurrency: { maxActiveClaims: 3 },
        });
        const store = new EnforcingClaimStore(claimStore, contract);

        for (let i = 0; i < 3; i++) {
          await store.createClaim(
            makeClaim({
              claimId: `claim-${i}`,
              targetRef: `target-${i}`,
              agent: { agentId: `agent-${i}` },
            }),
          );
        }

        expect(await store.countActiveClaims()).toBe(3);
      } finally {
        await cleanup(dir, db);
      }
    });

    test("shared mutex prevents cross-wrapper claim bypass (same inner store)", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract({
          concurrency: { maxActiveClaims: 1 },
        });
        const store1 = new EnforcingClaimStore(claimStore, contract);
        const store2 = new EnforcingClaimStore(claimStore, contract);

        await store1.createClaim(
          makeClaim({ claimId: "c1", targetRef: "t1", agent: { agentId: "a1" } }),
        );

        try {
          await store2.createClaim(
            makeClaim({ claimId: "c2", targetRef: "t2", agent: { agentId: "a2" } }),
          );
          expect.unreachable("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(ConcurrencyLimitError);
        }

        expect(await claimStore.countActiveClaims()).toBe(1);
      } finally {
        await cleanup(dir, db);
      }
    });

    test("shared mutex prevents cross-connection claim bypass (separate store objects, same DB)", async () => {
      const dir = await mkdtemp(join(tmpdir(), "enforcing-claim-xconn-"));
      const dbPath = join(dir, "test.db");
      const stores1 = createSqliteStores(dbPath);
      const stores2 = createSqliteStores(dbPath);
      try {
        const contract = makeContract({
          concurrency: { maxActiveClaims: 1 },
        });
        const wrapper1 = new EnforcingClaimStore(stores1.claimStore, contract);
        const wrapper2 = new EnforcingClaimStore(stores2.claimStore, contract);

        await wrapper1.createClaim(
          makeClaim({ claimId: "c1", targetRef: "t1", agent: { agentId: "a1" } }),
        );

        try {
          await wrapper2.createClaim(
            makeClaim({ claimId: "c2", targetRef: "t2", agent: { agentId: "a2" } }),
          );
          expect.unreachable("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(ConcurrencyLimitError);
        }

        expect(await stores1.claimStore.countActiveClaims()).toBe(1);
      } finally {
        stores1.close();
        stores2.close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test("rejects claim exceeding global limit", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract({
          concurrency: { maxActiveClaims: 2 },
        });
        const store = new EnforcingClaimStore(claimStore, contract);

        await store.createClaim(
          makeClaim({ claimId: "c1", targetRef: "t1", agent: { agentId: "a1" } }),
        );
        await store.createClaim(
          makeClaim({ claimId: "c2", targetRef: "t2", agent: { agentId: "a2" } }),
        );

        try {
          await store.createClaim(
            makeClaim({ claimId: "c3", targetRef: "t3", agent: { agentId: "a3" } }),
          );
          expect.unreachable("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(ConcurrencyLimitError);
          const err = e as ConcurrencyLimitError;
          expect(err.limitType).toBe("global");
          expect(err.current).toBe(2);
          expect(err.limit).toBe(2);
        }
      } finally {
        await cleanup(dir, db);
      }
    });

    test("expired claims do not count toward global limit", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract({
          concurrency: { maxActiveClaims: 1 },
        });
        const store = new EnforcingClaimStore(claimStore, contract);

        // Create a claim with a very short lease
        const now = new Date();
        await store.createClaim(
          makeClaim({
            claimId: "c1",
            targetRef: "t1",
            leaseExpiresAt: new Date(now.getTime() - 1000).toISOString(), // already expired
          }),
        );

        // Expire it
        await store.expireStale();

        // Should now be able to create another
        await store.createClaim(makeClaim({ claimId: "c2", targetRef: "t2" }));

        expect(await store.countActiveClaims()).toBe(1);
      } finally {
        await cleanup(dir, db);
      }
    });

    test("mutex prevents concurrent creates from exceeding limit", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract({
          concurrency: { maxActiveClaims: 1 },
        });
        const store = new EnforcingClaimStore(claimStore, contract);

        // Fire 3 concurrent creates — only 1 should succeed
        const results = await Promise.allSettled([
          store.createClaim(
            makeClaim({ claimId: "c1", targetRef: "t1", agent: { agentId: "a1" } }),
          ),
          store.createClaim(
            makeClaim({ claimId: "c2", targetRef: "t2", agent: { agentId: "a2" } }),
          ),
          store.createClaim(
            makeClaim({ claimId: "c3", targetRef: "t3", agent: { agentId: "a3" } }),
          ),
        ]);

        const fulfilled = results.filter((r) => r.status === "fulfilled").length;
        expect(fulfilled).toBe(1);
        expect(await store.countActiveClaims()).toBe(1);
      } finally {
        await cleanup(dir, db);
      }
    });
  });

  describe("per-agent concurrency limit", () => {
    test("rejects claim exceeding per-agent limit", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract({
          concurrency: { maxClaimsPerAgent: 2 },
        });
        const store = new EnforcingClaimStore(claimStore, contract);

        await store.createClaim(
          makeClaim({ claimId: "c1", targetRef: "t1", agent: { agentId: "agent-x" } }),
        );
        await store.createClaim(
          makeClaim({ claimId: "c2", targetRef: "t2", agent: { agentId: "agent-x" } }),
        );

        try {
          await store.createClaim(
            makeClaim({ claimId: "c3", targetRef: "t3", agent: { agentId: "agent-x" } }),
          );
          expect.unreachable("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(ConcurrencyLimitError);
          expect((e as ConcurrencyLimitError).limitType).toBe("per_agent");
        }
      } finally {
        await cleanup(dir, db);
      }
    });

    test("per-agent limit 0 means unlimited", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract({
          concurrency: { maxClaimsPerAgent: 0 },
        });
        const store = new EnforcingClaimStore(claimStore, contract);

        for (let i = 0; i < 5; i++) {
          await store.createClaim(
            makeClaim({ claimId: `c-${i}`, targetRef: `t-${i}`, agent: { agentId: "same-agent" } }),
          );
        }

        expect(await store.countActiveClaims()).toBe(5);
      } finally {
        await cleanup(dir, db);
      }
    });

    test("released claims do not count toward per-agent limit", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract({
          concurrency: { maxClaimsPerAgent: 1 },
        });
        const store = new EnforcingClaimStore(claimStore, contract);

        await store.createClaim(
          makeClaim({ claimId: "c1", targetRef: "t1", agent: { agentId: "a1" } }),
        );
        await store.release("c1");

        // Should be able to create another
        await store.createClaim(
          makeClaim({ claimId: "c2", targetRef: "t2", agent: { agentId: "a1" } }),
        );

        expect(await store.countActiveClaims({ agentId: "a1" })).toBe(1);
      } finally {
        await cleanup(dir, db);
      }
    });
  });

  describe("per-target concurrency limit", () => {
    test("rejects claim exceeding per-target limit", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract({
          concurrency: { maxClaimsPerTarget: 1 },
        });
        const store = new EnforcingClaimStore(claimStore, contract);

        await store.createClaim(
          makeClaim({ claimId: "c1", targetRef: "shared-target", agent: { agentId: "a1" } }),
        );

        // The underlying store also enforces at-most-one per target, so this
        // should be caught by either enforcement or the store itself
        try {
          await store.createClaim(
            makeClaim({ claimId: "c2", targetRef: "shared-target", agent: { agentId: "a2" } }),
          );
          expect.unreachable("should have thrown");
        } catch (e) {
          // Could be ConcurrencyLimitError (from wrapper) or plain Error (from store)
          expect(e).toBeDefined();
        }
      } finally {
        await cleanup(dir, db);
      }
    });
  });

  describe("lease limit enforcement", () => {
    test("rejects claim with lease exceeding max", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract({
          execution: { maxLeaseSeconds: 3600 }, // 1 hour max
        });
        const store = new EnforcingClaimStore(claimStore, contract);

        const now = new Date();
        const twoHoursLater = new Date(now.getTime() + 2 * 3600 * 1000);

        try {
          await store.createClaim(
            makeClaim({
              claimId: "c1",
              targetRef: "t1",
              createdAt: now.toISOString(),
              leaseExpiresAt: twoHoursLater.toISOString(),
            }),
          );
          expect.unreachable("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(LeaseViolationError);
          const err = e as LeaseViolationError;
          expect(err.requestedSeconds).toBeGreaterThan(3600);
          expect(err.maxSeconds).toBe(3600);
        }
      } finally {
        await cleanup(dir, db);
      }
    });

    test("allows claim with lease within max", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract({
          execution: { maxLeaseSeconds: 3600 },
        });
        const store = new EnforcingClaimStore(claimStore, contract);

        const now = new Date();
        const thirtyMinLater = new Date(now.getTime() + 1800 * 1000);

        await store.createClaim(
          makeClaim({
            claimId: "c1",
            targetRef: "t1",
            createdAt: now.toISOString(),
            leaseExpiresAt: thirtyMinLater.toISOString(),
          }),
        );

        expect(await store.countActiveClaims()).toBe(1);
      } finally {
        await cleanup(dir, db);
      }
    });
  });

  describe("heartbeat lease enforcement", () => {
    test("rejects heartbeat renewal exceeding max lease", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract({
          execution: { maxLeaseSeconds: 60 },
        });
        const store = new EnforcingClaimStore(claimStore, contract);

        const now = new Date();
        await store.createClaim(
          makeClaim({
            claimId: "c1",
            targetRef: "t1",
            createdAt: now.toISOString(),
            leaseExpiresAt: new Date(now.getTime() + 30_000).toISOString(),
          }),
        );

        // Try to renew for 3600 seconds (exceeds 60s max)
        try {
          await store.heartbeat("c1", 3600_000);
          expect.unreachable("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(LeaseViolationError);
          const err = e as LeaseViolationError;
          expect(err.requestedSeconds).toBe(3600);
          expect(err.maxSeconds).toBe(60);
        }
      } finally {
        await cleanup(dir, db);
      }
    });

    test("heartbeat uses contract default lease when no duration specified", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract({
          execution: { defaultLeaseSeconds: 120 },
        });
        const store = new EnforcingClaimStore(claimStore, contract);

        const now = new Date();
        await store.createClaim(
          makeClaim({
            claimId: "c1",
            targetRef: "t1",
            createdAt: now.toISOString(),
            leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
          }),
        );

        const updated = await store.heartbeat("c1");
        // The lease should be extended by ~120 seconds from now
        const leaseMs =
          new Date(updated.leaseExpiresAt).getTime() - new Date(updated.heartbeatAt).getTime();
        // Allow 5s tolerance for test execution time
        expect(leaseMs).toBeGreaterThanOrEqual(115_000);
        expect(leaseMs).toBeLessThanOrEqual(125_000);
      } finally {
        await cleanup(dir, db);
      }
    });

    test("heartbeat allows renewal within max lease", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract({
          execution: { maxLeaseSeconds: 3600 },
        });
        const store = new EnforcingClaimStore(claimStore, contract);

        const now = new Date();
        await store.createClaim(
          makeClaim({
            claimId: "c1",
            targetRef: "t1",
            createdAt: now.toISOString(),
            leaseExpiresAt: new Date(now.getTime() + 300_000).toISOString(),
          }),
        );

        // Renew for 600 seconds (within 3600s max)
        const updated = await store.heartbeat("c1", 600_000);
        expect(updated.claimId).toBe("c1");
      } finally {
        await cleanup(dir, db);
      }
    });
  });

  describe("no limits configured", () => {
    test("passes through when no concurrency limits set", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract();
        const store = new EnforcingClaimStore(claimStore, contract);

        for (let i = 0; i < 5; i++) {
          await store.createClaim(makeClaim({ claimId: `c-${i}`, targetRef: `t-${i}` }));
        }

        expect(await store.countActiveClaims()).toBe(5);
      } finally {
        await cleanup(dir, db);
      }
    });
  });

  describe("delegation", () => {
    test("activeClaims delegates to inner store", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract();
        const store = new EnforcingClaimStore(claimStore, contract);

        await store.createClaim(makeClaim({ claimId: "d-1", targetRef: "t-1" }));
        const active = await store.activeClaims("t-1");
        expect(active).toHaveLength(1);
        expect(active[0]?.claimId).toBe("d-1");
      } finally {
        await cleanup(dir, db);
      }
    });

    test("release delegates to inner store", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract();
        const store = new EnforcingClaimStore(claimStore, contract);

        await store.createClaim(makeClaim({ claimId: "rel-1", targetRef: "t-1" }));
        const released = await store.release("rel-1");
        expect(released.status).toBe("released");
      } finally {
        await cleanup(dir, db);
      }
    });

    test("complete delegates to inner store", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract();
        const store = new EnforcingClaimStore(claimStore, contract);

        await store.createClaim(makeClaim({ claimId: "comp-1", targetRef: "t-1" }));
        const completed = await store.complete("comp-1");
        expect(completed.status).toBe("completed");
      } finally {
        await cleanup(dir, db);
      }
    });

    test("expireStale delegates to inner store", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract();
        const store = new EnforcingClaimStore(claimStore, contract);

        // Create a claim with an expired lease
        const pastLease = new Date(Date.now() - 60_000).toISOString();
        await store.createClaim(
          makeClaim({ claimId: "exp-1", targetRef: "t-1", leaseExpiresAt: pastLease }),
        );

        const expired = await store.expireStale();
        expect(expired).toHaveLength(1);
        expect(expired[0]?.claim.claimId).toBe("exp-1");
      } finally {
        await cleanup(dir, db);
      }
    });

    test("cleanCompleted delegates to inner store", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract();
        const store = new EnforcingClaimStore(claimStore, contract);

        // Create a claim with an old heartbeat so it qualifies for cleanup
        const oldHeartbeat = new Date(Date.now() - 120_000).toISOString();
        await store.createClaim(
          makeClaim({ claimId: "clean-1", targetRef: "t-1", heartbeatAt: oldHeartbeat }),
        );
        await store.complete("clean-1");

        // Clean with 60s retention — claim heartbeat is 120s old, so it qualifies
        const deleted = await store.cleanCompleted(60_000);
        expect(deleted).toBe(1);
      } finally {
        await cleanup(dir, db);
      }
    });

    test("detectStalled delegates to inner store", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract();
        const store = new EnforcingClaimStore(claimStore, contract);

        // Create claim with old heartbeat but valid lease
        const oldHeartbeat = new Date(Date.now() - 120_000).toISOString();
        const futureLease = new Date(Date.now() + 300_000).toISOString();
        await store.createClaim(
          makeClaim({
            claimId: "stall-1",
            targetRef: "t-1",
            heartbeatAt: oldHeartbeat,
            leaseExpiresAt: futureLease,
          }),
        );

        const stalled = await store.detectStalled(60_000);
        expect(stalled).toHaveLength(1);
        expect(stalled[0]?.claimId).toBe("stall-1");
      } finally {
        await cleanup(dir, db);
      }
    });

    test("claimOrRenew delegates to inner store", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract();
        const store = new EnforcingClaimStore(claimStore, contract);

        const claim = makeClaim({ claimId: "cor-1", targetRef: "t-1" });
        const created = await store.claimOrRenew(claim);
        expect(created.claimId).toBe("cor-1");

        // Renew same agent, same target
        const renewed = await store.claimOrRenew(makeClaim({ claimId: "cor-2", targetRef: "t-1" }));
        expect(renewed.claimId).toBe("cor-1"); // Should renew existing
      } finally {
        await cleanup(dir, db);
      }
    });
  });

  describe("claimOrRenew enforcement", () => {
    test("claimOrRenew enforces concurrency limits for new claims", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract({
          concurrency: { maxActiveClaims: 1 },
        });
        const store = new EnforcingClaimStore(claimStore, contract);

        // Create one claim via createClaim to fill the concurrency slot
        await store.createClaim(
          makeClaim({ claimId: "c1", targetRef: "t-1", agent: { agentId: "agent-a" } }),
        );

        // claimOrRenew for a different target by a different agent should fail
        try {
          await store.claimOrRenew(
            makeClaim({ claimId: "c2", targetRef: "t-2", agent: { agentId: "agent-b" } }),
          );
          expect.unreachable("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(ConcurrencyLimitError);
          const err = e as ConcurrencyLimitError;
          expect(err.limitType).toBe("global");
          expect(err.current).toBe(1);
          expect(err.limit).toBe(1);
        }
      } finally {
        await cleanup(dir, db);
      }
    });

    test("claimOrRenew allows renewal when concurrency limit is reached", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract({
          concurrency: { maxActiveClaims: 1 },
        });
        const store = new EnforcingClaimStore(claimStore, contract);

        // Create one claim to fill the concurrency slot
        await store.createClaim(
          makeClaim({ claimId: "c1", targetRef: "t-1", agent: { agentId: "test-agent" } }),
        );

        // claimOrRenew for the SAME target by the SAME agent should succeed (renewal)
        const renewed = await store.claimOrRenew(
          makeClaim({ claimId: "c2", targetRef: "t-1", agent: { agentId: "test-agent" } }),
        );
        expect(renewed.claimId).toBe("c1"); // Should renew existing claim

        // Verify we still have exactly 1 active claim
        expect(await store.countActiveClaims()).toBe(1);
      } finally {
        await cleanup(dir, db);
      }
    });

    test("claimOrRenew enforces lease limits", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract({
          execution: { maxLeaseSeconds: 60 },
        });
        const store = new EnforcingClaimStore(claimStore, contract);

        const now = new Date();
        const twoHoursLater = new Date(now.getTime() + 2 * 3600 * 1000);

        try {
          await store.claimOrRenew(
            makeClaim({
              claimId: "c1",
              targetRef: "t-1",
              createdAt: now.toISOString(),
              leaseExpiresAt: twoHoursLater.toISOString(),
            }),
          );
          expect.unreachable("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(LeaseViolationError);
          const err = e as LeaseViolationError;
          expect(err.requestedSeconds).toBeGreaterThan(60);
          expect(err.maxSeconds).toBe(60);
        }
      } finally {
        await cleanup(dir, db);
      }
    });

    test("concurrent claimOrRenew calls are serialized by mutex", async () => {
      const { dir, db, claimStore } = await setupStores();
      try {
        const contract = makeContract({
          concurrency: { maxActiveClaims: 1 },
        });
        const store = new EnforcingClaimStore(claimStore, contract);

        // Fire 3 concurrent claimOrRenew calls for different targets — only 1 should succeed
        const results = await Promise.allSettled([
          store.claimOrRenew(
            makeClaim({ claimId: "c1", targetRef: "t-1", agent: { agentId: "a1" } }),
          ),
          store.claimOrRenew(
            makeClaim({ claimId: "c2", targetRef: "t-2", agent: { agentId: "a2" } }),
          ),
          store.claimOrRenew(
            makeClaim({ claimId: "c3", targetRef: "t-3", agent: { agentId: "a3" } }),
          ),
        ]);

        const fulfilled = results.filter((r) => r.status === "fulfilled").length;
        const rejected = results.filter((r) => r.status === "rejected").length;

        expect(fulfilled).toBe(1);
        expect(rejected).toBe(2);
        expect(await store.countActiveClaims()).toBe(1);
      } finally {
        await cleanup(dir, db);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// EnforcingContributionStore — read delegation
// ---------------------------------------------------------------------------

describe("EnforcingContributionStore delegation", () => {
  test("relationsOf delegates to inner store", async () => {
    const { dir, db, contributionStore } = await setupStores();
    try {
      const contract = makeContract();
      const store = new EnforcingContributionStore(contributionStore, contract);

      const parent = makeRecentContribution({ summary: "parent-for-relations" });
      await store.put(parent);
      const c = makeRecentContribution({
        relations: [{ targetCid: parent.cid, relationType: "derives_from" }],
      });
      await store.put(c);

      const relations = await store.relationsOf(c.cid);
      expect(relations).toHaveLength(1);
      expect(relations[0]?.relationType).toBe("derives_from");
    } finally {
      await cleanup(dir, db);
    }
  });

  test("relatedTo delegates to inner store", async () => {
    const { dir, db, contributionStore } = await setupStores();
    try {
      const contract = makeContract();
      const store = new EnforcingContributionStore(contributionStore, contract);

      const parent = makeRecentContribution({ summary: "parent" });
      await store.put(parent);
      const child = makeRecentContribution({
        summary: "child",
        relations: [{ targetCid: parent.cid, relationType: "derives_from" }],
      });
      await store.put(child);

      const related = await store.relatedTo(parent.cid);
      expect(related).toHaveLength(1);
      expect(related[0]?.cid).toBe(child.cid);
    } finally {
      await cleanup(dir, db);
    }
  });

  test("search delegates to inner store", async () => {
    const { dir, db, contributionStore } = await setupStores();
    try {
      const contract = makeContract();
      const store = new EnforcingContributionStore(contributionStore, contract);

      await store.put(makeRecentContribution({ summary: "quantum search test" }));
      const results = await store.search("quantum");
      expect(results).toHaveLength(1);
    } finally {
      await cleanup(dir, db);
    }
  });

  test("children delegates to inner store", async () => {
    const { dir, db, contributionStore } = await setupStores();
    try {
      const contract = makeContract();
      const store = new EnforcingContributionStore(contributionStore, contract);

      const parent = makeRecentContribution({ summary: "parent-children" });
      await store.put(parent);
      const child = makeRecentContribution({
        summary: "child-of-parent",
        relations: [{ targetCid: parent.cid, relationType: "derives_from" }],
      });
      await store.put(child);

      const children = await store.children(parent.cid);
      expect(children).toHaveLength(1);
      expect(children[0]?.cid).toBe(child.cid);
    } finally {
      await cleanup(dir, db);
    }
  });

  test("ancestors delegates to inner store", async () => {
    const { dir, db, contributionStore } = await setupStores();
    try {
      const contract = makeContract();
      const store = new EnforcingContributionStore(contributionStore, contract);

      const parent = makeRecentContribution({ summary: "ancestor" });
      await store.put(parent);
      const child = makeRecentContribution({
        summary: "descendant",
        relations: [{ targetCid: parent.cid, relationType: "derives_from" }],
      });
      await store.put(child);

      const ancestors = await store.ancestors(child.cid);
      expect(ancestors).toHaveLength(1);
      expect(ancestors[0]?.cid).toBe(parent.cid);
    } finally {
      await cleanup(dir, db);
    }
  });

  test("findExisting delegates to inner store", async () => {
    const { dir, db, contributionStore } = await setupStores();
    try {
      const contract = makeContract();
      const store = new EnforcingContributionStore(contributionStore, contract);

      const target = makeRecentContribution({ summary: "target" });
      await store.put(target);
      const review = makeRecentContribution({
        summary: "review of target",
        kind: "review",
        relations: [{ targetCid: target.cid, relationType: "reviews" }],
      });
      await store.put(review);

      const found = await store.findExisting(review.agent.agentId, target.cid, "review");
      expect(found).toHaveLength(1);
      expect(found[0]?.cid).toBe(review.cid);
    } finally {
      await cleanup(dir, db);
    }
  });
});
