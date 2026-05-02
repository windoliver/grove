/**
 * Unit tests for the per-view ClaimEntity → Claim / ContributionEntity →
 * Contribution projection helpers used by the PR2 (#388) view migrations.
 *
 * Each migrated view (claims, agent-list, pipeline-view, agent-graph,
 * activity, activity-panel, search-panel) defines an `entityToClaim` /
 * `entityToContribution` helper inline. They share the same shape; this
 * file pins the contract via the same fixtures.
 */

import { describe, expect, test } from "bun:test";
import type { AgentSession } from "../../core/agent-runtime.js";
import { agentSessionToEntity, claimToEntity, contributionToEntity } from "../../core/entity.js";
import { makeClaim, makeContribution } from "../../core/test-helpers.js";

describe("entity → flat round-trip (PR2 #388 view projections)", () => {
  test("claimToEntity preserves the fields views read back", () => {
    const claim = makeClaim({
      claimId: "claim-1",
      targetRef: "task-A",
      intentSummary: "do the thing",
    });
    const entity = claimToEntity(claim, () => Date.parse(claim.heartbeatAt));
    expect(entity.id).toBe(claim.claimId);
    expect(entity.spec.targetRef).toBe(claim.targetRef);
    expect(entity.spec.intentSummary).toBe(claim.intentSummary);
    expect(entity.spec.agent).toEqual(claim.agent);
    expect(entity.status.heartbeatAt).toBe(claim.heartbeatAt);
    expect(entity.status.leaseExpiresAt).toBe(claim.leaseExpiresAt);
    // Active phase round-trips correctly so views' "active" predicate works.
    expect(entity.status.phase).toBe("active");
  });

  test("contributionToEntity preserves the fields views read back", () => {
    const c = makeContribution({ summary: "test entry" });
    const entity = contributionToEntity(c, "default");
    expect(entity.id).toBe(c.cid);
    expect(entity.spec.contributionKind).toBe(c.kind);
    expect(entity.spec.mode).toBe(c.mode);
    expect(entity.spec.summary).toBe(c.summary);
    expect(entity.spec.tags).toEqual(c.tags);
    expect(entity.spec.agent).toEqual(c.agent);
    expect(entity.metadata.creationTimestamp).toBe(c.createdAt);
  });

  test("agentSessionToEntity preserves the fields views read back", () => {
    const s: AgentSession = {
      id: "grove-coord-1-abc",
      role: "coordinator",
      status: "running",
      pid: 12345,
      platform: "claude-code",
      model: "sonnet",
      agent: "claude",
    };
    const entity = agentSessionToEntity(s, undefined, "default");
    expect(entity.id).toBe(s.id);
    expect(entity.spec.role).toBe(s.role);
    expect(entity.spec.platform).toBe(s.platform);
    expect(entity.spec.model).toBe(s.model);
    expect(entity.spec.agent).toBe(s.agent);
    expect(entity.status.phase).toBe(s.status);
    expect(entity.status.pid).toBe(s.pid);
  });
});
