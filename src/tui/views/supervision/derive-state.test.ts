import { describe, expect, test } from "bun:test";
import { ClaimStatus, ContributionKind, RelationType } from "../../../core/models.js";
import { makeClaim, makeContribution } from "../../../core/test-helpers.js";
import { classifyAgent, type ClassifyInput } from "./derive-state.js";
import { DEFAULT_THRESHOLDS } from "./thresholds.js";

const NOW = Date.parse("2026-05-15T12:00:00Z");

function base(overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    claim: makeClaim({
      status: ClaimStatus.Active,
      leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
      createdAt: new Date(NOW - 30_000).toISOString(),
    }),
    contributions: [],
    handoffTargetUnhealthy: false,
    handoffServerState: undefined,
    pendingApproval: undefined,
    completedAt: undefined,
    now: NOW,
    thresholds: DEFAULT_THRESHOLDS,
    ...overrides,
  };
}

describe("classifyAgent priority order", () => {
  test("awaiting beats every other condition when pendingApproval is set", () => {
    const c = classifyAgent(
      base({
        pendingApproval: {
          agentId: "a",
          requestId: "r",
          kind: "tmux-permission",
          prompt: "cmd",
          fullBody: "cmd",
          requestedAt: NOW,
        },
        claim: makeClaim({
          status: ClaimStatus.Active,
          leaseExpiresAt: new Date(NOW - 1_000).toISOString(),
        }),
      }),
    );
    expect(c.state).toBe("awaiting");
  });

  test("blocked beats thrashing/stuck/silent when lease expired", () => {
    const c = classifyAgent(
      base({
        claim: makeClaim({
          status: ClaimStatus.Active,
          leaseExpiresAt: new Date(NOW - 1_000).toISOString(),
        }),
      }),
    );
    expect(c.state).toBe("blocked");
  });

  test("blocked when handoff target unhealthy even with valid lease", () => {
    const c = classifyAgent(base({ handoffTargetUnhealthy: true }));
    expect(c.state).toBe("blocked");
  });

  test("blocked when handoff server-state is overdue/blocked/dead_lettered", () => {
    for (const s of ["overdue", "blocked", "dead_lettered"] as const) {
      const c = classifyAgent(base({ handoffServerState: s }));
      expect(c.state).toBe("blocked");
    }
  });

  test("thrashing when >= thrashContribs to same target within window", () => {
    const sameCid = "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const contribs = Array.from({ length: 6 }, (_, i) =>
      makeContribution({
        summary: "loop",
        createdAt: new Date(NOW - (i + 1) * 5_000).toISOString(),
        relations: [{ targetCid: sameCid, relationType: RelationType.DerivesFrom }],
      }),
    );
    const c = classifyAgent(base({ contributions: contribs }));
    expect(c.state).toBe("thrashing");
  });

  test("not thrashing when contribs target different cids", () => {
    const cids = [
      "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "blake3:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "blake3:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "blake3:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      "blake3:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    ];
    const contribs = Array.from({ length: 6 }, (_, i) =>
      makeContribution({
        summary: "varied",
        createdAt: new Date(NOW - (i + 1) * 5_000).toISOString(),
        relations: [{ targetCid: cids[i]!, relationType: RelationType.DerivesFrom }],
      }),
    );
    const c = classifyAgent(base({ contributions: contribs }));
    expect(c.state).not.toBe("thrashing");
  });

  test("thrashing keys on primary relation (relations[0]); secondary relations don't trigger", () => {
    // 6 contribs whose relations[0] targets DIFFER, but relations[1] shares.
    // Should NOT classify as thrashing — secondary relations are not the key.
    const SAME_SECONDARY = "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const contribs = Array.from({ length: 6 }, (_, i) =>
      makeContribution({
        summary: `c${i}`,
        createdAt: new Date(NOW - (i + 1) * 5_000).toISOString(),
        relations: [
          { targetCid: `blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa${i}`, relationType: RelationType.DerivesFrom },
          { targetCid: SAME_SECONDARY, relationType: RelationType.DerivesFrom },
        ],
      }),
    );
    const c = classifyAgent(base({ contributions: contribs }));
    expect(c.state).not.toBe("thrashing");
  });

  test("stuck when same task > stuckMs and contribution-kind diversity = 1", () => {
    const contribs = Array.from({ length: 4 }, (_, i) =>
      makeContribution({
        kind: ContributionKind.Work,
        summary: "long",
        createdAt: new Date(NOW - (i + 1) * 30_000).toISOString(),
      }),
    );
    const c = classifyAgent(
      base({
        contributions: contribs,
        claim: makeClaim({
          status: ClaimStatus.Active,
          leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
          createdAt: new Date(NOW - 700_000).toISOString(),
        }),
      }),
    );
    expect(c.state).toBe("stuck");
  });

  test("not stuck when kinds diversify (operator-visible progress)", () => {
    const contribs = [
      makeContribution({
        kind: ContributionKind.Work,
        createdAt: new Date(NOW - 60_000).toISOString(),
      }),
      makeContribution({
        kind: ContributionKind.Review,
        createdAt: new Date(NOW - 30_000).toISOString(),
      }),
    ];
    const c = classifyAgent(
      base({
        contributions: contribs,
        claim: makeClaim({
          status: ClaimStatus.Active,
          leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
          createdAt: new Date(NOW - 700_000).toISOString(),
        }),
      }),
    );
    expect(c.state).not.toBe("stuck");
  });

  test("silent when no contribution > silentMs and lease valid", () => {
    const contribs = [
      makeContribution({ createdAt: new Date(NOW - 200_000).toISOString() }),
    ];
    const c = classifyAgent(base({ contributions: contribs }));
    expect(c.state).toBe("silent");
  });

  test("brand-new agent (no contribs) is running, not silent, until silentMs elapses", () => {
    const c = classifyAgent(
      base({
        contributions: [],
        claim: makeClaim({
          status: ClaimStatus.Active,
          leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
          createdAt: new Date(NOW - 30_000).toISOString(),
        }),
      }),
    );
    expect(c.state).toBe("running");
  });

  test("brand-new agent becomes silent once silentMs elapses from claim createdAt", () => {
    const c = classifyAgent(
      base({
        contributions: [],
        claim: makeClaim({
          status: ClaimStatus.Active,
          leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
          createdAt: new Date(NOW - 200_000).toISOString(),
        }),
      }),
    );
    expect(c.state).toBe("silent");
  });

  test("running when active claim + recent contribution", () => {
    const c = classifyAgent(
      base({
        contributions: [
          makeContribution({ createdAt: new Date(NOW - 10_000).toISOString() }),
        ],
      }),
    );
    expect(c.state).toBe("running");
  });

  test("done when completedAt within completedRetentionMs", () => {
    const c = classifyAgent(
      base({
        claim: makeClaim({ status: ClaimStatus.Released }),
        completedAt: NOW - 30_000,
      }),
    );
    expect(c.state).toBe("done");
  });

  test("idle when no active claim and not recently completed", () => {
    const c = classifyAgent(
      base({
        claim: makeClaim({ status: ClaimStatus.Released }),
        completedAt: NOW - 200_000,
      }),
    );
    expect(c.state).toBe("idle");
  });
});

describe("classifyAgent annotations", () => {
  test("costSpike true when costUsdPerMin > threshold", () => {
    const c = classifyAgent(base({ costUsdLastMin: 2.5 }));
    expect(c.costSpike).toBe(true);
  });

  test("contextHot true when contextPercent >= critical", () => {
    const c = classifyAgent(base({ contextPercent: 96 }));
    expect(c.contextHot).toBe(true);
  });

  test("annotations are additive, primary state unaffected", () => {
    const c = classifyAgent(
      base({
        contextPercent: 96,
        costUsdLastMin: 2.5,
        contributions: [
          makeContribution({ createdAt: new Date(NOW - 10_000).toISOString() }),
        ],
      }),
    );
    expect(c.state).toBe("running");
    expect(c.contextHot).toBe(true);
    expect(c.costSpike).toBe(true);
  });
});

describe("classifyAgent stateReason text", () => {
  test("blocked due to expired lease names the reason", () => {
    const c = classifyAgent(
      base({
        claim: makeClaim({
          status: ClaimStatus.Active,
          leaseExpiresAt: new Date(NOW - 1_000).toISOString(),
        }),
      }),
    );
    expect(c.stateReason).toMatch(/lease/i);
  });

  test("silent reports duration", () => {
    const c = classifyAgent(
      base({
        contributions: [
          makeContribution({ createdAt: new Date(NOW - 180_000).toISOString() }),
        ],
      }),
    );
    expect(c.stateReason).toMatch(/3m/);
  });
});
