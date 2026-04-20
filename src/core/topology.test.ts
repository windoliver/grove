/**
 * Tests for agent topology schema and wire-format conversion.
 */

import { describe, expect, test } from "bun:test";
import { makeTopology } from "./test-helpers.js";
import { AgentTopologySchema, wireToTopology } from "./topology.js";

// ---------------------------------------------------------------------------
// Schema validation — valid topologies
// ---------------------------------------------------------------------------

describe("AgentTopologySchema", () => {
  test("accepts valid flat topology", () => {
    const result = AgentTopologySchema.safeParse({
      structure: "flat",
      roles: [{ name: "worker" }, { name: "reviewer" }],
    });
    expect(result.success).toBe(true);
  });

  test("accepts valid graph topology with edges", () => {
    const result = AgentTopologySchema.safeParse({
      structure: "graph",
      roles: [
        { name: "coder", edges: [{ target: "reviewer", edge_type: "delegates" }] },
        { name: "reviewer", edges: [{ target: "coder", edge_type: "feedback" }] },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("accepts valid tree topology", () => {
    const result = AgentTopologySchema.safeParse({
      structure: "tree",
      roles: [
        { name: "coordinator", edges: [{ target: "worker", edge_type: "delegates" }] },
        { name: "worker" },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("accepts topology with spawning config", () => {
    const result = AgentTopologySchema.safeParse({
      structure: "graph",
      roles: [{ name: "worker" }],
      spawning: { dynamic: true, max_depth: 3, max_children_per_agent: 5 },
    });
    expect(result.success).toBe(true);
  });

  test("accepts topology with optional fields", () => {
    const result = AgentTopologySchema.safeParse({
      structure: "graph",
      roles: [
        {
          name: "coder",
          description: "writes code",
          max_instances: 3,
          command: "claude --role coder",
          edges: [{ target: "reviewer", edge_type: "delegates" }],
        },
        { name: "reviewer" },
      ],
      edge_types: ["custom_type"],
    });
    expect(result.success).toBe(true);
  });

  test("accepts single-role flat topology", () => {
    const result = AgentTopologySchema.safeParse({
      structure: "flat",
      roles: [{ name: "solo" }],
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Schema validation — invalid topologies
// ---------------------------------------------------------------------------

describe("AgentTopologySchema rejects", () => {
  test("empty roles array", () => {
    const result = AgentTopologySchema.safeParse({
      structure: "flat",
      roles: [],
    });
    expect(result.success).toBe(false);
  });

  test("duplicate role names", () => {
    const result = AgentTopologySchema.safeParse({
      structure: "flat",
      roles: [{ name: "worker" }, { name: "worker" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("duplicate"))).toBe(true);
    }
  });

  test("invalid role name format (uppercase)", () => {
    const result = AgentTopologySchema.safeParse({
      structure: "flat",
      roles: [{ name: "Worker" }],
    });
    expect(result.success).toBe(false);
  });

  test("self-edge", () => {
    const result = AgentTopologySchema.safeParse({
      structure: "graph",
      roles: [{ name: "worker", edges: [{ target: "worker", edge_type: "delegates" }] }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("self-edge"))).toBe(true);
    }
  });

  test("edge target referencing undefined role", () => {
    const result = AgentTopologySchema.safeParse({
      structure: "graph",
      roles: [{ name: "worker", edges: [{ target: "ghost", edge_type: "delegates" }] }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("not a defined role"))).toBe(true);
    }
  });

  test("flat topology with edges", () => {
    const result = AgentTopologySchema.safeParse({
      structure: "flat",
      roles: [{ name: "a", edges: [{ target: "b", edge_type: "delegates" }] }, { name: "b" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("flat topology"))).toBe(true);
    }
  });

  test("tree topology with multiple roots", () => {
    const result = AgentTopologySchema.safeParse({
      structure: "tree",
      roles: [{ name: "root-a" }, { name: "root-b" }, { name: "leaf" }],
    });
    expect(result.success).toBe(false);
  });

  test("tree topology with multiple incoming edges", () => {
    const result = AgentTopologySchema.safeParse({
      structure: "tree",
      roles: [
        { name: "a", edges: [{ target: "c", edge_type: "delegates" }] },
        { name: "b", edges: [{ target: "c", edge_type: "delegates" }] },
        { name: "c" },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("single parent"))).toBe(true);
    }
  });

  test("invalid edge_type enum", () => {
    const result = AgentTopologySchema.safeParse({
      structure: "graph",
      roles: [{ name: "a", edges: [{ target: "b", edge_type: "invalid" }] }, { name: "b" }],
    });
    expect(result.success).toBe(false);
  });

  test("invalid structure type", () => {
    const result = AgentTopologySchema.safeParse({
      structure: "ring",
      roles: [{ name: "a" }],
    });
    expect(result.success).toBe(false);
  });

  test("spawning max_depth out of range", () => {
    const result = AgentTopologySchema.safeParse({
      structure: "graph",
      roles: [{ name: "a" }],
      spawning: { dynamic: true, max_depth: 100 },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge type enum validation
// ---------------------------------------------------------------------------

describe("EdgeType enum", () => {
  const validTypes = ["delegates", "reports", "feeds", "requests", "feedback", "escalates"];

  for (const type of validTypes) {
    test(`accepts '${type}'`, () => {
      const result = AgentTopologySchema.safeParse({
        structure: "graph",
        roles: [{ name: "a", edges: [{ target: "b", edge_type: type }] }, { name: "b" }],
      });
      expect(result.success).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// wireToTopology conversion
// ---------------------------------------------------------------------------

describe("wireToTopology", () => {
  test("converts snake_case to camelCase", () => {
    const wire = {
      structure: "graph" as const,
      roles: [
        {
          name: "coder",
          max_instances: 3,
          edges: [{ target: "reviewer", edge_type: "delegates" as const }],
          command: "claude --role coder",
        },
        {
          name: "reviewer",
          description: "Reviews code",
        },
      ],
      spawning: {
        dynamic: true,
        max_depth: 2,
        max_children_per_agent: 4,
        timeout_seconds: 300,
      },
      edge_types: ["custom"],
    };

    const topology = wireToTopology(wire);

    expect(topology.structure).toBe("graph");
    expect(topology.roles).toHaveLength(2);

    const coder = topology.roles[0]!;
    expect(coder.name).toBe("coder");
    expect(coder.maxInstances).toBe(3);
    expect(coder.edges).toHaveLength(1);
    expect(coder.edges?.[0]?.edgeType).toBe("delegates");
    expect(coder.command).toBe("claude --role coder");

    const reviewer = topology.roles[1]!;
    expect(reviewer.description).toBe("Reviews code");

    expect(topology.spawning?.dynamic).toBe(true);
    expect(topology.spawning?.maxDepth).toBe(2);
    expect(topology.spawning?.maxChildrenPerAgent).toBe(4);
    expect(topology.spawning?.timeoutSeconds).toBe(300);
    expect(topology.edgeTypes).toEqual(["custom"]);
  });

  test("omits undefined optional fields", () => {
    const wire = {
      structure: "flat" as const,
      roles: [{ name: "worker" }],
    };

    const topology = wireToTopology(wire);
    expect(topology.spawning).toBeUndefined();
    expect(topology.edgeTypes).toBeUndefined();
    expect(topology.roles[0]?.edges).toBeUndefined();
    expect(topology.roles[0]?.maxInstances).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SpawningConfig constraints
// ---------------------------------------------------------------------------

describe("SpawningConfig validation", () => {
  test("accepts valid spawning config", () => {
    const result = AgentTopologySchema.safeParse({
      structure: "graph",
      roles: [{ name: "a" }],
      spawning: { dynamic: true, max_depth: 5, max_children_per_agent: 10, timeout_seconds: 600 },
    });
    expect(result.success).toBe(true);
  });

  test("rejects max_depth below minimum (1)", () => {
    const result = AgentTopologySchema.safeParse({
      structure: "graph",
      roles: [{ name: "a" }],
      spawning: { dynamic: true, max_depth: 0 },
    });
    expect(result.success).toBe(false);
  });

  test("rejects timeout_seconds below minimum (10)", () => {
    const result = AgentTopologySchema.safeParse({
      structure: "graph",
      roles: [{ name: "a" }],
      spawning: { dynamic: true, timeout_seconds: 5 },
    });
    expect(result.success).toBe(false);
  });

  test("rejects unknown spawning fields", () => {
    const result = AgentTopologySchema.safeParse({
      structure: "graph",
      roles: [{ name: "a" }],
      spawning: { dynamic: true, unknown_field: 42 },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// makeTopology test helper
// ---------------------------------------------------------------------------

describe("makeTopology", () => {
  test("creates default graph topology", () => {
    const t = makeTopology();
    expect(t.structure).toBe("graph");
    expect(t.roles).toHaveLength(2);
    expect(t.roles[0]?.name).toBe("coder");
    expect(t.roles[1]?.name).toBe("reviewer");
  });

  test("accepts overrides", () => {
    const t = makeTopology({
      structure: "flat",
      roles: [{ name: "solo" }],
    });
    expect(t.structure).toBe("flat");
    expect(t.roles).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: parseGroveContract → topology
// ---------------------------------------------------------------------------

describe("parseGroveContract topology integration", () => {
  test("parses V3 contract with topology", async () => {
    const { parseGroveContract } = await import("./contract.js");

    const contract = parseGroveContract(`---
contract_version: 3
name: topo-test
mode: exploration
agent_topology:
  structure: graph
  roles:
    - name: coder
      max_instances: 2
      edges:
        - target: reviewer
          edge_type: delegates
    - name: reviewer
---
# Topology Test
`);

    expect(contract.topology).toBeDefined();
    expect(contract.topology?.structure).toBe("graph");
    expect(contract.topology?.roles).toHaveLength(2);
    expect(contract.topology?.roles[0]?.maxInstances).toBe(2);
  });

  test("V2 contract has no topology", async () => {
    const { parseGroveContract } = await import("./contract.js");

    const contract = parseGroveContract(`---
contract_version: 2
name: no-topo
mode: evaluation
---
# No Topology
`);

    expect(contract.topology).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// topology skills field
// ---------------------------------------------------------------------------

describe("topology skills field", () => {
  test("parses skills list on a role", () => {
    const parsed = AgentTopologySchema.parse({
      structure: "flat",
      roles: [
        { name: "coder", skills: ["grove", "review"] },
      ],
    });
    const topology = wireToTopology(parsed);
    expect(topology.roles[0]?.skills).toEqual(["grove", "review"]);
  });

  test("omits skills when not provided", () => {
    const parsed = AgentTopologySchema.parse({
      structure: "flat",
      roles: [{ name: "coder" }],
    });
    const topology = wireToTopology(parsed);
    expect(topology.roles[0]?.skills).toBeUndefined();
  });

  test("rejects non-string entries in skills", () => {
    expect(() =>
      AgentTopologySchema.parse({
        structure: "flat",
        roles: [{ name: "coder", skills: [123] }],
      }),
    ).toThrow();
  });
});
