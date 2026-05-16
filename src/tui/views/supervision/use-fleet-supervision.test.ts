import { describe, expect, test } from "bun:test";
import { ClaimStatus } from "../../../core/models.js";
import { makeAgent, makeClaim, makeContribution } from "../../../core/test-helpers.js";
import { buildSupervisedFleet } from "./use-fleet-supervision.js";
import { DEFAULT_THRESHOLDS } from "./thresholds.js";

const NOW = Date.parse("2026-05-15T12:00:00Z");

describe("buildSupervisedFleet", () => {
  test("joins claim + contributions + cost into SupervisedAgent", () => {
    const claim = makeClaim({
      status: ClaimStatus.Active,
      leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
      createdAt: new Date(NOW - 30_000).toISOString(),
      agent: makeAgent({ agentId: "a-1" }),
      targetRef: "task-x",
    });
    const contribs = [makeContribution({
      createdAt: new Date(NOW - 5_000).toISOString(),
      agent: makeAgent({ agentId: "a-1" }),
    })];
    const fleet = buildSupervisedFleet({
      claims: [claim],
      contributions: contribs,
      costs: new Map([["a-1", { costUsd: 0.42, tokens: 1000, contextPercent: 73 }]]),
      sessions: new Map([["a-1", "agent-a-1-session"]]),
      pendingApprovals: [],
      handoffsByAgent: new Map(),
      completedClaimsByAgent: new Map(),
      contribsByAgent: new Map([["a-1", contribs]]),
      now: NOW,
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(fleet).toHaveLength(1);
    const sa = fleet[0];
    expect(sa.agentId).toBe("a-1");
    expect(sa.state).toBe("running");
    expect(sa.costUsd).toBe(0.42);
    expect(sa.contextPercent).toBe(73);
    expect(sa.sessionName).toBe("agent-a-1-session");
    expect(sa.currentTask).toBe("task-x");
    expect(sa.contribCount).toBe(1);
  });

  test("missing cost entry yields zero cost, no spike", () => {
    const claim = makeClaim({
      status: ClaimStatus.Active,
      leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
      agent: makeAgent({ agentId: "a-2" }),
    });
    const fleet = buildSupervisedFleet({
      claims: [claim],
      contributions: [],
      costs: new Map(),
      sessions: new Map(),
      pendingApprovals: [],
      handoffsByAgent: new Map(),
      completedClaimsByAgent: new Map(),
      contribsByAgent: new Map(),
      now: NOW,
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(fleet[0].costUsd).toBe(0);
    expect(fleet[0].costSpike).toBe(false);
  });

  test("pending approval flips state to awaiting", () => {
    const claim = makeClaim({
      status: ClaimStatus.Active,
      leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
      agent: makeAgent({ agentId: "a-3" }),
    });
    const fleet = buildSupervisedFleet({
      claims: [claim],
      contributions: [],
      costs: new Map(),
      sessions: new Map(),
      pendingApprovals: [{
        agentId: "a-3",
        requestId: "req-1",
        kind: "tmux-permission",
        prompt: "rm -rf node_modules",
        fullBody: "cmd: rm -rf node_modules\ncwd: /repo",
        requestedAt: NOW - 5_000,
      }],
      handoffsByAgent: new Map(),
      completedClaimsByAgent: new Map(),
      contribsByAgent: new Map(),
      now: NOW,
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(fleet[0].state).toBe("awaiting");
    expect(fleet[0].pendingApproval?.requestId).toBe("req-1");
  });

  test("retains released claims for completedRetentionMs as 'done'", () => {
    const claim = makeClaim({
      status: ClaimStatus.Released,
      agent: makeAgent({ agentId: "a-4" }),
    });
    const fleet = buildSupervisedFleet({
      claims: [claim],
      contributions: [],
      costs: new Map(),
      sessions: new Map(),
      pendingApprovals: [],
      handoffsByAgent: new Map(),
      completedClaimsByAgent: new Map([["a-4", NOW - 30_000]]),
      contribsByAgent: new Map(),
      now: NOW,
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(fleet[0].state).toBe("done");
  });

  test("agent with multiple claims uses the most recent active one", () => {
    const oldClaim = makeClaim({
      claimId: "old",
      status: ClaimStatus.Released,
      agent: makeAgent({ agentId: "a-5" }),
      createdAt: new Date(NOW - 600_000).toISOString(),
    });
    const newClaim = makeClaim({
      claimId: "new",
      status: ClaimStatus.Active,
      leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
      createdAt: new Date(NOW - 30_000).toISOString(),
      agent: makeAgent({ agentId: "a-5" }),
      targetRef: "current-task",
    });
    const fleet = buildSupervisedFleet({
      claims: [oldClaim, newClaim],
      contributions: [],
      costs: new Map(),
      sessions: new Map(),
      pendingApprovals: [],
      handoffsByAgent: new Map(),
      completedClaimsByAgent: new Map(),
      contribsByAgent: new Map(),
      now: NOW,
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(fleet).toHaveLength(1);
    expect(fleet[0].currentTask).toBe("current-task");
  });
});
