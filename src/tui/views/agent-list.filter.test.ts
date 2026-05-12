/**
 * Tests for C2 (#302) filter predicate in AgentListView.
 *
 * Closes the integration gap that unit tests in `aliases.test.ts` and the
 * acceptance test in `running-view.c2.test.tsx` don't reach: that the
 * `filterText` prop builds a predicate that narrows EntityView's claim
 * stream correctly.
 *
 * The filter operates over ClaimEntity (post-EntityView migration in C1
 * #301) — earlier versions of this PR filtered the legacy `Table`-ready
 * Record<string,string>[] shape. Tests exercise the predicate factory
 * directly against representative ClaimEntity values.
 */

import { describe, expect, test } from "bun:test";
import type { ClaimEntity } from "../../core/entity.js";
import { buildAgentFilter } from "./agent-list.js";

function makeClaim(over: {
  agentId: string;
  agentName?: string | undefined;
  role?: string | undefined;
  platform?: string | undefined;
  targetRef: string;
}): ClaimEntity {
  return {
    apiVersion: "v1",
    kind: "Claim",
    id: over.agentId,
    metadata: { creationTimestamp: "2026-05-08T00:00:00.000Z" },
    spec: {
      targetRef: over.targetRef,
      agent: {
        agentId: over.agentId,
        agentName: over.agentName,
        role: over.role,
        platform: over.platform,
      },
      intentSummary: "test",
      context: undefined,
    },
    status: {
      phase: "active",
      heartbeatAt: "2026-05-08T00:00:00.000Z",
      leaseExpiresAt: "2026-05-08T01:00:00.000Z",
      attemptCount: 1,
    },
  } as unknown as ClaimEntity;
}

const claims: readonly ClaimEntity[] = [
  makeClaim({
    agentId: "coder-1",
    agentName: "coder-1",
    role: "coder",
    platform: "claude",
    targetRef: "review/intake",
  }),
  makeClaim({
    agentId: "reviewer-1",
    agentName: "reviewer-1",
    role: "reviewer",
    platform: "codex",
    targetRef: "review/intake",
  }),
  makeClaim({
    agentId: "perf-bot",
    agentName: "perf-bot",
    role: "perf-bot",
    platform: "gemini",
    targetRef: "bench/perf",
  }),
];

function apply(filter: string | undefined): readonly ClaimEntity[] {
  const pred = buildAgentFilter(filter);
  return pred ? claims.filter(pred) : claims;
}

describe("C2 agent-list filter (buildAgentFilter)", () => {
  test("empty / undefined filter returns undefined predicate (no narrowing)", () => {
    expect(buildAgentFilter(undefined)).toBeUndefined();
    expect(buildAgentFilter("")).toBeUndefined();
    expect(buildAgentFilter("   ")).toBeUndefined();
  });

  test("filter narrows to matching role", () => {
    const r = apply("coder");
    expect(r.length).toBe(1);
    expect(r[0]?.spec.agent.agentId).toBe("coder-1");
  });

  test("filter narrows to matching platform", () => {
    const r = apply("codex");
    expect(r.length).toBe(1);
    expect(r[0]?.spec.agent.role).toBe("reviewer");
  });

  test("filter is case-insensitive", () => {
    expect(apply("PERF").length).toBe(1);
    expect(apply("Perf").length).toBe(1);
    expect(apply("perf").length).toBe(1);
  });

  test("filter searches across role + agentId + targetRef", () => {
    expect(apply("intake").length).toBe(2);
    expect(apply("bench").length).toBe(1);
  });

  test("substring matching, not exact", () => {
    // 'rev' matches reviewer-1's role/agentId AND coder-1's review/intake target.
    expect(apply("rev").length).toBe(2);
  });

  test("no matches returns empty", () => {
    expect(apply("zzznomatch").length).toBe(0);
  });
});
