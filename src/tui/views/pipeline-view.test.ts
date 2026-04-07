/**
 * Tests for pipeline-view pure functions.
 *
 * Tests buildPipeline — the function that merges claims + tmux sessions
 * into AgentCard display data. No React renderer needed.
 */

import { describe, expect, test } from "bun:test";
import type { Claim } from "../../core/models.js";
import { buildPipeline } from "./pipeline-view.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClaim(
  agentId: string,
  opts: {
    agentName?: string;
    role?: string;
    platform?: string;
    leaseExpiresAt?: string;
    parentAgentId?: string;
  } = {},
): Claim {
  const now = new Date().toISOString();
  const futureExpiry = new Date(Date.now() + 60_000).toISOString();
  return {
    claimId: `claim-${agentId}`,
    targetRef: "ref-1",
    status: "active",
    intentSummary: "working",
    createdAt: now,
    heartbeatAt: now,
    leaseExpiresAt: opts.leaseExpiresAt ?? futureExpiry,
    agent: {
      agentId,
      ...(opts.agentName !== undefined ? { agentName: opts.agentName } : {}),
      ...(opts.role !== undefined ? { role: opts.role } : { role: "worker" }),
      ...(opts.platform !== undefined ? { platform: opts.platform } : { platform: "claude" }),
    },
    ...(opts.parentAgentId !== undefined
      ? { context: { parentAgentId: opts.parentAgentId } }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// buildPipeline
// ---------------------------------------------------------------------------

describe("buildPipeline", () => {
  test("returns empty array when no claims", () => {
    const result = buildPipeline([], [], new Map());
    expect(result).toEqual([]);
  });

  test("basic card shape: agentId uses agentName when available", () => {
    const claim = makeClaim("agent-abc", { agentName: "coder" });
    const result = buildPipeline([claim], [], new Map());
    expect(result.length).toBe(1);
    expect(result[0]?.agentId).toBe("coder");
  });

  test("falls back to agentId when agentName is undefined", () => {
    const claim = makeClaim("agent-xyz");
    const result = buildPipeline([claim], [], new Map());
    expect(result[0]?.agentId).toBe("agent-xyz");
  });

  test("status=running when session is alive and lease is valid", () => {
    const claim = makeClaim("agent-1", { agentName: "worker" });
    // session name encodes agentId via agentIdFromSession convention
    const sessions = ["grove-agent-1"];
    const result = buildPipeline([claim], sessions, new Map());
    // Agent is in sessions list → alive
    expect(result[0]?.status).toBe("running");
  });

  test("status=expired when lease has expired regardless of session", () => {
    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    const claim = makeClaim("agent-1", { leaseExpiresAt: pastExpiry });
    const result = buildPipeline([claim], ["grove-agent-1"], new Map());
    expect(result[0]?.status).toBe("expired");
  });

  test("status=error when claim has valid lease but session is not running", () => {
    const claim = makeClaim("agent-1");
    const result = buildPipeline([claim], [], new Map()); // no sessions → not alive
    expect(result[0]?.status).toBe("error");
  });

  test("lastLines: parses terminal output, keeps last 3 non-empty lines", () => {
    const claim = makeClaim("agent-1");
    const sessions = ["grove-agent-1"];
    const outputs = new Map([["grove-agent-1", "line1\nline2\nline3\nline4\nline5"]]);
    const result = buildPipeline([claim], sessions, outputs);
    expect(result[0]?.lastLines).toEqual(["line3", "line4", "line5"]);
  });

  test("lastLines: empty string output produces empty lastLines", () => {
    const claim = makeClaim("agent-1");
    const outputs = new Map([["grove-agent-1", ""]]);
    const result = buildPipeline([claim], ["grove-agent-1"], outputs);
    expect(result[0]?.lastLines).toEqual([]);
  });

  test("lastLines: filters out blank lines", () => {
    const claim = makeClaim("agent-1");
    const outputs = new Map([["grove-agent-1", "line1\n\n   \nline2"]]);
    const result = buildPipeline([claim], ["grove-agent-1"], outputs);
    expect(result[0]?.lastLines).toEqual(["line1", "line2"]);
  });

  test("sorting: coordinator (no parentId) comes before workers", () => {
    const coordinator = makeClaim("coord");
    const worker1 = makeClaim("worker-a", { parentAgentId: "coord" });
    const worker2 = makeClaim("worker-b", { parentAgentId: "coord" });
    // Pass in reverse order to verify sorting
    const result = buildPipeline([worker1, worker2, coordinator], [], new Map());
    expect(result[0]?.agentId).toBe("coord");
  });

  test("sorting: workers with same depth are sorted alphabetically by agentId", () => {
    const worker1 = makeClaim("zeta", { parentAgentId: "coord" });
    const worker2 = makeClaim("alpha", { parentAgentId: "coord" });
    const result = buildPipeline([worker1, worker2], [], new Map());
    expect(result[0]?.agentId).toBe("alpha");
    expect(result[1]?.agentId).toBe("zeta");
  });

  test("platform defaults to 'custom' when not set on agent", () => {
    // Build a claim with no platform field
    const claim: Claim = {
      claimId: "c1",
      targetRef: "ref",
      status: "active",
      intentSummary: "work",
      createdAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      agent: { agentId: "agent-1" },
    };
    const result = buildPipeline([claim], [], new Map());
    expect(result[0]?.platform).toBe("custom");
  });

  test("role defaults to 'worker' when not set on agent", () => {
    const claim: Claim = {
      claimId: "c1",
      targetRef: "ref",
      status: "active",
      intentSummary: "work",
      createdAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      agent: { agentId: "agent-1" },
    };
    const result = buildPipeline([claim], [], new Map());
    expect(result[0]?.role).toBe("worker");
  });
});
