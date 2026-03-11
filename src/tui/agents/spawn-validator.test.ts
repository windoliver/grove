/**
 * Tests for spawn validation helpers.
 */

import { describe, expect, test } from "bun:test";

import type { Claim } from "../../core/models.js";
import type { AgentTopology } from "../../core/topology.js";
import { checkSpawn, checkSpawnChildren, checkSpawnDepth } from "./spawn-validator.js";

/** Helper to create a minimal active claim with a role. */
function makeClaim(role: string, agentId = "agent-1"): Claim {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  return {
    claimId: `claim-${agentId}`,
    targetRef: `src/${role}`,
    agent: { agentId, role },
    status: "active",
    intentSummary: "working",
    createdAt: now,
    heartbeatAt: now,
    leaseExpiresAt: future,
  };
}

const coderRole = { name: "coder", maxInstances: 3 };
const reviewerRole = { name: "reviewer", maxInstances: 2 };
const leadRole = { name: "lead" }; // no maxInstances

const topology: AgentTopology = {
  structure: "graph",
  roles: [coderRole, reviewerRole, leadRole],
};

describe("checkSpawn", () => {
  test("no topology — always allowed", () => {
    const result = checkSpawn(undefined, "coder", []);
    expect(result.allowed).toBe(true);
    expect(result.role).toBeUndefined();
    expect(result.currentInstances).toBe(0);
    expect(result.maxInstances).toBeUndefined();
    expect(result.warning).toBeUndefined();
  });

  test("valid role under capacity — allowed", () => {
    const claims = [makeClaim("coder", "a1")];
    const result = checkSpawn(topology, "coder", claims);
    expect(result.allowed).toBe(true);
    expect(result.role).toEqual(coderRole);
    expect(result.currentInstances).toBe(1);
    expect(result.maxInstances).toBe(3);
    expect(result.warning).toBeUndefined();
  });

  test("role at max_instances — not allowed with warning", () => {
    const claims = [makeClaim("coder", "a1"), makeClaim("coder", "a2"), makeClaim("coder", "a3")];
    const result = checkSpawn(topology, "coder", claims);
    expect(result.allowed).toBe(false);
    expect(result.role).toEqual(coderRole);
    expect(result.currentInstances).toBe(3);
    expect(result.maxInstances).toBe(3);
    expect(result.warning).toBe("Role 'coder' at capacity (3/3)");
  });

  test("counts unique agents, not total claims — allowed when same agent holds multiple claims", () => {
    // Agent "a1" holds two claims on different targets but is still one instance
    const claims = [makeClaim("coder", "a1"), makeClaim("coder", "a1"), makeClaim("coder", "a2")];
    const result = checkSpawn(topology, "coder", claims);
    expect(result.allowed).toBe(true);
    expect(result.currentInstances).toBe(2); // 2 unique agents, not 3 claims
    expect(result.maxInstances).toBe(3);
    expect(result.warning).toBeUndefined();
  });

  test("unknown role — not allowed with warning", () => {
    const result = checkSpawn(topology, "nonexistent", []);
    expect(result.allowed).toBe(false);
    expect(result.role).toBeUndefined();
    expect(result.warning).toBe("Role 'nonexistent' not defined in topology");
  });

  test("no maxInstances set — always allowed for that role", () => {
    const claims = [
      makeClaim("lead", "a1"),
      makeClaim("lead", "a2"),
      makeClaim("lead", "a3"),
      makeClaim("lead", "a4"),
    ];
    const result = checkSpawn(topology, "lead", claims);
    expect(result.allowed).toBe(true);
    expect(result.role).toEqual(leadRole);
    expect(result.currentInstances).toBe(4);
    expect(result.maxInstances).toBeUndefined();
    expect(result.warning).toBeUndefined();
  });
});

describe("checkSpawnDepth", () => {
  const topologyWithSpawning: AgentTopology = {
    structure: "graph",
    roles: [coderRole],
    spawning: { dynamic: true, maxDepth: 3 },
  };

  test("depth within limit — allowed", () => {
    const result = checkSpawnDepth(topologyWithSpawning, 2);
    expect(result.allowed).toBe(true);
    expect(result.maxDepth).toBe(3);
    expect(result.warning).toBeUndefined();
  });

  test("depth exceeds max_depth — not allowed with warning", () => {
    const result = checkSpawnDepth(topologyWithSpawning, 3);
    expect(result.allowed).toBe(false);
    expect(result.maxDepth).toBe(3);
    expect(result.warning).toBe("Spawn depth 3 exceeds max_depth 3");
  });

  test("no spawning config — depth always allowed", () => {
    const result = checkSpawnDepth(topology, 10);
    expect(result.allowed).toBe(true);
    expect(result.maxDepth).toBeUndefined();
    expect(result.warning).toBeUndefined();
  });

  test("no topology — depth always allowed", () => {
    const result = checkSpawnDepth(undefined, 10);
    expect(result.allowed).toBe(true);
    expect(result.maxDepth).toBeUndefined();
    expect(result.warning).toBeUndefined();
  });
});

/** Helper to create a claim with a parentAgentId in context. */
function makeChildClaim(role: string, parentAgentId: string, agentId = "child-1"): Claim {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  return {
    claimId: `claim-${agentId}`,
    targetRef: `src/${role}`,
    agent: { agentId, role },
    status: "active",
    intentSummary: "working",
    createdAt: now,
    heartbeatAt: now,
    leaseExpiresAt: future,
    context: { parentAgentId },
  };
}

describe("checkSpawnChildren", () => {
  const topologyWithChildren: AgentTopology = {
    structure: "graph",
    roles: [coderRole],
    spawning: { dynamic: true, maxChildrenPerAgent: 2 },
  };

  test("no topology — always allowed", () => {
    const result = checkSpawnChildren(undefined, "parent-1", []);
    expect(result.allowed).toBe(true);
    expect(result.currentChildren).toBe(0);
    expect(result.maxChildrenPerAgent).toBeUndefined();
  });

  test("no spawning config — always allowed", () => {
    const result = checkSpawnChildren(topology, "parent-1", []);
    expect(result.allowed).toBe(true);
    expect(result.currentChildren).toBe(0);
    expect(result.maxChildrenPerAgent).toBeUndefined();
  });

  test("no maxChildrenPerAgent — always allowed", () => {
    const topoNoMax: AgentTopology = {
      structure: "graph",
      roles: [coderRole],
      spawning: { dynamic: true },
    };
    const result = checkSpawnChildren(topoNoMax, "parent-1", []);
    expect(result.allowed).toBe(true);
    expect(result.maxChildrenPerAgent).toBeUndefined();
  });

  test("under child limit — allowed", () => {
    const claims = [makeChildClaim("coder", "parent-1", "child-1")];
    const result = checkSpawnChildren(topologyWithChildren, "parent-1", claims);
    expect(result.allowed).toBe(true);
    expect(result.currentChildren).toBe(1);
    expect(result.maxChildrenPerAgent).toBe(2);
  });

  test("at child limit — not allowed with warning", () => {
    const claims = [
      makeChildClaim("coder", "parent-1", "child-1"),
      makeChildClaim("coder", "parent-1", "child-2"),
    ];
    const result = checkSpawnChildren(topologyWithChildren, "parent-1", claims);
    expect(result.allowed).toBe(false);
    expect(result.currentChildren).toBe(2);
    expect(result.maxChildrenPerAgent).toBe(2);
    expect(result.warning).toBe("Parent agent 'parent-1' at child capacity (2/2)");
  });

  test("counts only children of the specified parent", () => {
    const claims = [
      makeChildClaim("coder", "parent-1", "child-1"),
      makeChildClaim("coder", "parent-2", "child-2"),
    ];
    const result = checkSpawnChildren(topologyWithChildren, "parent-1", claims);
    expect(result.allowed).toBe(true);
    expect(result.currentChildren).toBe(1);
  });
});

describe("checkSpawn with parentAgentId", () => {
  const topologyWithChildren: AgentTopology = {
    structure: "graph",
    roles: [coderRole, reviewerRole, leadRole],
    spawning: { dynamic: true, maxChildrenPerAgent: 2 },
  };

  test("allowed when parent has room for children", () => {
    const claims = [makeChildClaim("coder", "parent-1", "child-1")];
    const result = checkSpawn(topologyWithChildren, "coder", claims, "parent-1");
    expect(result.allowed).toBe(true);
  });

  test("not allowed when parent at child capacity", () => {
    const claims = [
      makeChildClaim("coder", "parent-1", "child-1"),
      makeChildClaim("coder", "parent-1", "child-2"),
    ];
    const result = checkSpawn(topologyWithChildren, "coder", claims, "parent-1");
    expect(result.allowed).toBe(false);
    expect(result.warning).toBe("Parent agent 'parent-1' at child capacity (2/2)");
  });

  test("no parentAgentId — children check is skipped", () => {
    const claims = [
      makeChildClaim("coder", "parent-1", "child-1"),
      makeChildClaim("coder", "parent-1", "child-2"),
    ];
    const result = checkSpawn(topologyWithChildren, "coder", claims);
    expect(result.allowed).toBe(true);
  });
});
