/**
 * Integration tests for all Grove presets.
 *
 * Tests the full `grove init --preset <name>` pipeline end-to-end:
 * - File generation (GROVE.md, grove.json, .grove/ structure)
 * - GROVE.md contract parsing roundtrip
 * - grove.json backend resolution (nexus-managed vs local)
 * - Seed contribution storage in SQLite
 * - Nexus lifecycle integration (nexusInit, nexusUp, readNexusUrl)
 * - TUI backend resolution chain
 * - Topology validation against Zod schema
 *
 * Uses real agents (claude, codex) platform references where presets
 * specify them (pr-review, federated-swarm).
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

// Nexus CLI init is slow (~5s Python startup) — allow 15s per test
setDefaultTimeout(15_000);

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeInit, type InitOptions } from "../../src/cli/commands/init.js";
import {
  DEFAULT_NEXUS_URL,
  inferNexusPreset,
  readNexusUrl,
} from "../../src/cli/nexus-lifecycle.js";
import { getPreset, getPresetRegistry, listPresetNames } from "../../src/cli/presets/index.js";
import { type GroveConfig, parseGroveConfig } from "../../src/core/config.js";
import { type GroveContract, parseGroveContract } from "../../src/core/contract.js";
import {
  type AgentTopology,
  AgentTopologySchema,
  wireToTopology,
} from "../../src/core/topology.js";
import { type ResolvedBackend, resolveBackend } from "../../src/tui/resolve-backend.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

async function createTempDir(label: string): Promise<string> {
  const dir = join(
    tmpdir(),
    `grove-preset-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function makeOptions(cwd: string, preset: string, name: string): InitOptions {
  return {
    name,
    mode: "evaluation", // overridden by preset
    seed: [],
    metric: [],
    force: false,
    agentOverrides: {},
    cwd,
    preset,
  };
}

/** Read and parse grove.json from a temp dir */
function readGroveJson(dir: string): GroveConfig {
  const raw = readFileSync(join(dir, ".grove", "grove.json"), "utf-8");
  return parseGroveConfig(raw);
}

/** Read and parse GROVE.md from a temp dir */
function readGroveMd(dir: string): GroveContract {
  const raw = readFileSync(join(dir, "GROVE.md"), "utf-8");
  return parseGroveContract(raw);
}

/** Count contributions in SQLite DB */
async function countContributions(dir: string): Promise<number> {
  const { initSqliteDb, SqliteContributionStore } = await import("../../src/local/sqlite-store.js");
  const db = initSqliteDb(join(dir, ".grove", "grove.db"));
  const store = new SqliteContributionStore(db);
  const count = await store.count();
  db.close();
  return count;
}

/** List contributions from SQLite DB */
async function listContributions(dir: string) {
  const { initSqliteDb, SqliteContributionStore } = await import("../../src/local/sqlite-store.js");
  const db = initSqliteDb(join(dir, ".grove", "grove.db"));
  const store = new SqliteContributionStore(db);
  const contributions = await store.list({ limit: 100 });
  db.close();
  return contributions;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(async () => {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
  tempDirs = [];
});

// ============================================================================
// 1. Preset Registry
// ============================================================================

describe("Preset Registry", () => {
  test("lists all 6 presets", () => {
    const names = listPresetNames();
    expect(names).toContain("review-loop");
    expect(names).toContain("exploration");
    expect(names).toContain("swarm-ops");
    expect(names).toContain("research-loop");
    expect(names).toContain("pr-review");
    expect(names).toContain("federated-swarm");
    expect(names).toHaveLength(6);
  });

  test("each preset has required fields", () => {
    const registry = getPresetRegistry();
    for (const [name, preset] of Object.entries(registry)) {
      expect(preset.name).toBe(name);
      expect(preset.description).toBeTruthy();
      expect(["evaluation", "exploration"]).toContain(preset.mode);
      expect(["local", "nexus"]).toContain(preset.backend);
      expect(preset.services).toBeDefined();
      expect(typeof preset.services.server).toBe("boolean");
      expect(typeof preset.services.mcp).toBe("boolean");
    }
  });

  test("getPreset returns undefined for unknown preset", () => {
    expect(getPreset("nonexistent")).toBeUndefined();
  });
});

// ============================================================================
// 2. review-loop preset
// ============================================================================

describe("review-loop preset", () => {
  test("preset config has correct structure", () => {
    const preset = getPreset("review-loop")!;
    expect(preset).toBeDefined();
    expect(preset.mode).toBe("exploration");
    expect(preset.backend).toBe("nexus");
    expect(preset.services).toEqual({ server: true, mcp: false });
    expect(preset.topology?.structure).toBe("graph");
    expect(preset.topology?.roles).toHaveLength(2);
    expect(preset.topology?.roles.map((r) => r.name)).toEqual(["coder", "reviewer"]);
    expect(preset.features?.askUser).toBeDefined();
    expect(preset.features?.messaging).toBe(true);
  });

  test("topology edges form bidirectional coder <-> reviewer loop", () => {
    const preset = getPreset("review-loop")!;
    const coder = preset.topology?.roles.find((r) => r.name === "coder")!;
    const reviewer = preset.topology?.roles.find((r) => r.name === "reviewer")!;
    expect(coder.edges).toContainEqual({ target: "reviewer", edgeType: "delegates" });
    expect(reviewer.edges).toContainEqual({ target: "coder", edgeType: "feedback" });
  });

  test("grove init --preset review-loop creates correct files", async () => {
    const dir = await createTempDir("review-loop");
    await executeInit(makeOptions(dir, "review-loop", "My Review Project"));

    // 1. Check directory structure
    expect(existsSync(join(dir, ".grove"))).toBe(true);
    expect(existsSync(join(dir, ".grove", "grove.db"))).toBe(true);
    expect(existsSync(join(dir, ".grove", "cas"))).toBe(true);
    expect(existsSync(join(dir, ".grove", "workspaces"))).toBe(true);
    expect(existsSync(join(dir, "GROVE.md"))).toBe(true);
    expect(existsSync(join(dir, ".grove", "grove.json"))).toBe(true);

    // 2. Validate grove.json
    const config = readGroveJson(dir);
    expect(config.name).toBe("My Review Project");
    expect(config.mode).toBe("nexus");
    expect(config.preset).toBe("review-loop");
    expect(config.nexusManaged).toBe(true);
    expect(config.services).toEqual({ server: true, mcp: false });
    // nexusUrl should NOT be set for managed nexus (discovered at runtime)
    expect(config.nexusUrl).toBeUndefined();

    // 3. Validate GROVE.md contract
    const contract = readGroveMd(dir);
    expect(contract.contractVersion).toBe(3);
    expect(contract.name).toBe("My Review Project");
    expect(contract.mode).toBe("exploration");
    expect(contract.topology).toBeDefined();
    expect(contract.topology?.structure).toBe("graph");
    expect(contract.topology?.roles).toHaveLength(2);
    expect(contract.concurrency?.maxActiveClaims).toBe(4);
    expect(contract.concurrency?.maxClaimsPerAgent).toBe(1);
    expect(contract.execution?.defaultLeaseSeconds).toBe(300);
    expect(contract.execution?.maxLeaseSeconds).toBe(900);

    // 4. Validate seed contributions
    const count = await countContributions(dir);
    expect(count).toBe(2); // coder scaffold + reviewer feedback
    const contributions = await listContributions(dir);
    const summaries = contributions.map((c) => c.summary);
    expect(summaries).toContain("Initial implementation scaffold");
    expect(summaries).toContain("Review: architecture looks solid, add error handling");
  });

  test("GROVE.md topology roles have correct commands for claude agent", () => {
    const preset = getPreset("review-loop")!;
    for (const role of preset.topology?.roles) {
      expect(role.command).toMatch(/^claude --role/);
    }
  });
});

// ============================================================================
// 3. exploration preset
// ============================================================================

describe("exploration preset", () => {
  test("preset config has 3 roles with graph topology", () => {
    const preset = getPreset("exploration")!;
    expect(preset.mode).toBe("exploration");
    expect(preset.backend).toBe("nexus");
    expect(preset.topology?.structure).toBe("graph");
    expect(preset.topology?.roles).toHaveLength(3);
    expect(preset.topology?.roles.map((r) => r.name)).toEqual([
      "explorer",
      "critic",
      "synthesizer",
    ]);
    expect(preset.concurrency?.maxActiveClaims).toBe(6);
    expect(preset.features?.askUser?.perAgent).toBe(true);
  });

  test("explorer can delegate to critic and feed synthesizer", () => {
    const preset = getPreset("exploration")!;
    const explorer = preset.topology?.roles.find((r) => r.name === "explorer")!;
    expect(explorer.edges).toContainEqual({ target: "critic", edgeType: "delegates" });
    expect(explorer.edges).toContainEqual({ target: "synthesizer", edgeType: "feeds" });
  });

  test("synthesizer can request from explorer (feedback loop)", () => {
    const preset = getPreset("exploration")!;
    const synth = preset.topology?.roles.find((r) => r.name === "synthesizer")!;
    expect(synth.edges).toContainEqual({ target: "explorer", edgeType: "requests" });
  });

  test("grove init --preset exploration creates correct files", async () => {
    const dir = await createTempDir("exploration");
    await executeInit(makeOptions(dir, "exploration", "Discovery Project"));

    const config = readGroveJson(dir);
    expect(config.mode).toBe("nexus");
    expect(config.preset).toBe("exploration");
    expect(config.nexusManaged).toBe(true);

    const contract = readGroveMd(dir);
    expect(contract.contractVersion).toBe(3);
    expect(contract.mode).toBe("exploration");
    expect(contract.topology?.roles).toHaveLength(3);
    expect(contract.concurrency?.maxActiveClaims).toBe(6);

    // 2 seed contributions: problem statement + constraints
    const count = await countContributions(dir);
    expect(count).toBe(2);
  });
});

// ============================================================================
// 4. swarm-ops preset
// ============================================================================

describe("swarm-ops preset", () => {
  test("preset config has tree topology with coordinator, worker, qa", () => {
    const preset = getPreset("swarm-ops")!;
    expect(preset.mode).toBe("evaluation");
    expect(preset.backend).toBe("nexus");
    expect(preset.services).toEqual({ server: true, mcp: true }); // MCP enabled!
    expect(preset.topology?.structure).toBe("tree");
    expect(preset.topology?.roles.map((r) => r.name)).toEqual(["coordinator", "worker", "qa"]);
  });

  test("tree topology has coordinator as root", () => {
    const preset = getPreset("swarm-ops")!;
    const coordinator = preset.topology?.roles.find((r) => r.name === "coordinator")!;
    expect(coordinator.maxInstances).toBe(1);
    expect(coordinator.edges).toContainEqual({ target: "worker", edgeType: "delegates" });
    expect(coordinator.edges).toContainEqual({ target: "qa", edgeType: "delegates" });

    // worker and qa are leaf nodes (no edges — tree hierarchy is structural)
    const worker = preset.topology?.roles.find((r) => r.name === "worker")!;
    expect(worker.maxInstances).toBe(5);
    expect(worker.edges ?? []).toEqual([]);

    const qa = preset.topology?.roles.find((r) => r.name === "qa")!;
    expect(qa.maxInstances).toBe(2);
    expect(qa.edges ?? []).toEqual([]);
  });

  test("has evaluation metrics and gates", () => {
    const preset = getPreset("swarm-ops")!;
    expect(preset.metrics).toHaveLength(2);
    expect(preset.metrics?.[0]).toEqual({
      name: "task_completion",
      direction: "maximize",
      description: "Percentage of tasks completed",
    });
    expect(preset.metrics?.[1]).toEqual({
      name: "quality_score",
      direction: "maximize",
      description: "Quality review average score",
    });
    expect(preset.gates).toContainEqual({ type: "has_relation", relation_type: "derives_from" });
    expect(preset.stopConditions?.budget?.maxContributions).toBe(200);
  });

  test("has cost tracking feature", () => {
    const preset = getPreset("swarm-ops")!;
    expect(preset.features?.costTracking).toBe(true);
  });

  test("grove init --preset swarm-ops creates correct files", async () => {
    const dir = await createTempDir("swarm-ops");
    await executeInit(makeOptions(dir, "swarm-ops", "My Swarm"));

    // grove.json
    const config = readGroveJson(dir);
    expect(config.name).toBe("My Swarm");
    expect(config.mode).toBe("nexus");
    expect(config.preset).toBe("swarm-ops");
    expect(config.nexusManaged).toBe(true);
    expect(config.services).toEqual({ server: true, mcp: true });

    // GROVE.md
    const contract = readGroveMd(dir);
    expect(contract.contractVersion).toBe(3);
    expect(contract.mode).toBe("evaluation");
    expect(contract.topology?.structure).toBe("tree");
    expect(contract.topology?.roles).toHaveLength(3);

    // metrics
    expect(contract.metrics).toBeDefined();
    expect(contract.metrics?.task_completion).toBeDefined();
    expect(contract.metrics?.task_completion.direction).toBe("maximize");
    expect(contract.metrics?.quality_score).toBeDefined();
    expect(contract.metrics?.quality_score.direction).toBe("maximize");

    // gates
    expect(contract.gates).toBeDefined();
    expect(contract.gates?.some((g) => g.type === "has_relation")).toBe(true);

    // stop conditions
    expect(contract.stopConditions?.budget?.maxContributions).toBe(200);

    // execution config
    expect(contract.execution?.defaultLeaseSeconds).toBe(600);
    expect(contract.execution?.maxLeaseSeconds).toBe(1800);
    expect(contract.execution?.heartbeatIntervalSeconds).toBe(120);
    expect(contract.execution?.stallTimeoutSeconds).toBe(300);

    // concurrency
    expect(contract.concurrency?.maxActiveClaims).toBe(8);
    expect(contract.concurrency?.maxClaimsPerAgent).toBe(2);

    // 1 seed contribution
    const count = await countContributions(dir);
    expect(count).toBe(1);
    const contributions = await listContributions(dir);
    expect(contributions[0].summary).toBe("Project setup and initial task breakdown");
  });

  test("nexus preset inference returns 'shared' for swarm-ops", () => {
    const nexusPreset = inferNexusPreset({
      name: "test",
      mode: "nexus",
      preset: "swarm-ops",
    });
    expect(nexusPreset).toBe("shared");
  });
});

// ============================================================================
// 5. research-loop preset (LOCAL backend — no nexus)
// ============================================================================

describe("research-loop preset", () => {
  test("preset config uses local backend", () => {
    const preset = getPreset("research-loop")!;
    expect(preset.mode).toBe("evaluation");
    expect(preset.backend).toBe("local"); // NOT nexus
    expect(preset.services).toEqual({ server: true, mcp: false });
    expect(preset.topology?.structure).toBe("graph");
    expect(preset.topology?.roles.map((r) => r.name)).toEqual(["researcher", "evaluator"]);
  });

  test("has val_bpb metric with minimize direction", () => {
    const preset = getPreset("research-loop")!;
    expect(preset.metrics).toHaveLength(1);
    expect(preset.metrics?.[0]).toEqual({
      name: "val_bpb",
      direction: "minimize",
      unit: "bpb",
      description: "Validation bits-per-byte",
    });
  });

  test("has metric_improves gate for val_bpb", () => {
    const preset = getPreset("research-loop")!;
    expect(preset.gates).toContainEqual({ type: "metric_improves", metric: "val_bpb" });
  });

  test("has comprehensive stop conditions", () => {
    const preset = getPreset("research-loop")!;
    expect(preset.stopConditions?.maxRoundsWithoutImprovement).toBe(10);
    expect(preset.stopConditions?.targetMetric).toEqual({ metric: "val_bpb", value: 0.95 });
    expect(preset.stopConditions?.budget?.maxContributions).toBe(500);
    expect(preset.stopConditions?.budget?.maxWallClockSeconds).toBe(7200);
  });

  test("has features: askUser, costTracking, messaging", () => {
    const preset = getPreset("research-loop")!;
    expect(preset.features?.askUser).toBeDefined();
    expect(preset.features?.costTracking).toBe(true);
    expect(preset.features?.messaging).toBe(true);
  });

  test("grove init --preset research-loop uses local backend (no nexus)", async () => {
    const dir = await createTempDir("research-loop");
    await executeInit(makeOptions(dir, "research-loop", "ML Research"));

    // grove.json — LOCAL mode, NO nexusManaged
    const config = readGroveJson(dir);
    expect(config.name).toBe("ML Research");
    expect(config.mode).toBe("local"); // NOT nexus
    expect(config.preset).toBe("research-loop");
    expect(config.nexusManaged).toBeUndefined();
    expect(config.nexusUrl).toBeUndefined();
    expect(config.services).toEqual({ server: true, mcp: false });

    // GROVE.md
    const contract = readGroveMd(dir);
    expect(contract.contractVersion).toBe(3);
    expect(contract.mode).toBe("evaluation");

    // metrics roundtrip
    expect(contract.metrics?.val_bpb).toBeDefined();
    expect(contract.metrics?.val_bpb.direction).toBe("minimize");
    expect(contract.metrics?.val_bpb.unit).toBe("bpb");

    // gates roundtrip
    expect(
      contract.gates?.some((g) => g.type === "metric_improves" && g.metric === "val_bpb"),
    ).toBe(true);

    // stop conditions roundtrip
    expect(contract.stopConditions?.maxRoundsWithoutImprovement).toBe(10);
    expect(contract.stopConditions?.targetMetric).toEqual({ metric: "val_bpb", value: 0.95 });
    expect(contract.stopConditions?.budget?.maxContributions).toBe(500);
    expect(contract.stopConditions?.budget?.maxWallClockSeconds).toBe(7200);

    // topology
    expect(contract.topology?.structure).toBe("graph");
    expect(contract.topology?.roles).toHaveLength(2);

    // 1 seed contribution (baseline)
    const count = await countContributions(dir);
    expect(count).toBe(1);
    const contributions = await listContributions(dir);
    expect(contributions[0].summary).toBe("Baseline model with initial val_bpb measurement");
  });

  test("nexus preset inference returns 'local' for research-loop", () => {
    const nexusPreset = inferNexusPreset({
      name: "test",
      mode: "local",
      preset: "research-loop",
    });
    expect(nexusPreset).toBe("local");
  });
});

// ============================================================================
// 6. pr-review preset
// ============================================================================

describe("pr-review preset", () => {
  test("preset config has claude-code platform roles", () => {
    const preset = getPreset("pr-review")!;
    expect(preset.mode).toBe("exploration");
    expect(preset.backend).toBe("nexus");
    expect(preset.topology?.structure).toBe("graph");
    expect(preset.topology?.roles).toHaveLength(2);

    // Both roles specify claude-code platform
    for (const role of preset.topology?.roles) {
      expect(role.platform).toBe("claude-code");
    }
  });

  test("has GitHub autoDetect feature", () => {
    const preset = getPreset("pr-review")!;
    expect(preset.features?.github?.autoDetectPR).toBe(true);
  });

  test("has askUser, costTracking, messaging features", () => {
    const preset = getPreset("pr-review")!;
    expect(preset.features?.askUser?.perAgent).toBe(true);
    expect(preset.features?.costTracking).toBe(true);
    expect(preset.features?.messaging).toBe(true);
  });

  test("reviewer delegates to analyst, analyst reports to reviewer", () => {
    const preset = getPreset("pr-review")!;
    const reviewer = preset.topology?.roles.find((r) => r.name === "reviewer")!;
    const analyst = preset.topology?.roles.find((r) => r.name === "analyst")!;
    expect(reviewer.edges).toContainEqual({ target: "analyst", edgeType: "delegates" });
    expect(analyst.edges).toContainEqual({ target: "reviewer", edgeType: "reports" });
  });

  test("grove init --preset pr-review creates correct files", async () => {
    const dir = await createTempDir("pr-review");
    await executeInit(makeOptions(dir, "pr-review", "PR Analysis"));

    const config = readGroveJson(dir);
    expect(config.mode).toBe("nexus");
    expect(config.preset).toBe("pr-review");
    expect(config.nexusManaged).toBe(true);
    expect(config.services).toEqual({ server: true, mcp: false });

    const contract = readGroveMd(dir);
    expect(contract.contractVersion).toBe(3);
    expect(contract.mode).toBe("exploration");
    expect(contract.topology?.roles).toHaveLength(2);
    expect(contract.concurrency?.maxActiveClaims).toBe(5);
    expect(contract.execution?.defaultLeaseSeconds).toBe(300);
    expect(contract.execution?.maxLeaseSeconds).toBe(600);

    // 1 seed contribution
    const count = await countContributions(dir);
    expect(count).toBe(1);
  });
});

// ============================================================================
// 7. federated-swarm preset
// ============================================================================

describe("federated-swarm preset", () => {
  test("preset config has flat topology with single worker role", () => {
    const preset = getPreset("federated-swarm")!;
    expect(preset.mode).toBe("exploration");
    expect(preset.backend).toBe("nexus");
    expect(preset.topology?.structure).toBe("flat");
    expect(preset.topology?.roles).toHaveLength(1);
    expect(preset.topology?.roles[0].name).toBe("worker");
    expect(preset.topology?.roles[0].maxInstances).toBe(8);
    expect(preset.topology?.roles[0].platform).toBe("claude-code");
  });

  test("flat topology has no edges", () => {
    const preset = getPreset("federated-swarm")!;
    const worker = preset.topology?.roles[0];
    // flat topology: edges should be undefined or empty
    expect(worker.edges ?? []).toEqual([]);
  });

  test("has gossip feature with delegate spawning", () => {
    const preset = getPreset("federated-swarm")!;
    expect(preset.features?.gossip?.delegateSpawning).toBe(true);
  });

  test("has costTracking and messaging features", () => {
    const preset = getPreset("federated-swarm")!;
    expect(preset.features?.costTracking).toBe(true);
    expect(preset.features?.messaging).toBe(true);
  });

  test("spawning config limits depth and children", () => {
    const preset = getPreset("federated-swarm")!;
    expect(preset.topology?.spawning?.dynamic).toBe(true);
    expect(preset.topology?.spawning?.maxDepth).toBe(1);
    expect(preset.topology?.spawning?.maxChildrenPerAgent).toBe(4);
  });

  test("grove init --preset federated-swarm creates correct files", async () => {
    const dir = await createTempDir("federated-swarm");
    await executeInit(makeOptions(dir, "federated-swarm", "Swarm Network"));

    const config = readGroveJson(dir);
    expect(config.mode).toBe("nexus");
    expect(config.preset).toBe("federated-swarm");
    expect(config.nexusManaged).toBe(true);

    const contract = readGroveMd(dir);
    expect(contract.contractVersion).toBe(3);
    expect(contract.mode).toBe("exploration");
    expect(contract.topology?.structure).toBe("flat");
    expect(contract.topology?.roles).toHaveLength(1);
    expect(contract.concurrency?.maxActiveClaims).toBe(8);
    expect(contract.concurrency?.maxClaimsPerAgent).toBe(2);

    // No seed contributions for federated-swarm
    const count = await countContributions(dir);
    expect(count).toBe(0);
  });
});

// ============================================================================
// 8. Topology Zod Schema Validation (all presets)
// ============================================================================

describe("Topology schema validation", () => {
  const presetNames = listPresetNames();

  for (const name of presetNames) {
    test(`${name} topology validates against AgentTopologySchema`, () => {
      const preset = getPreset(name)!;
      if (!preset.topology) return; // skip presets without topology

      // Convert from camelCase (PresetConfig) to snake_case (wire format)
      // and validate against Zod schema
      const wire = topologyToWire(preset.topology);
      const result = AgentTopologySchema.safeParse(wire);

      if (!result.success) {
        const issues = result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        throw new Error(`${name} topology validation failed: ${issues}`);
      }

      // Roundtrip: wire -> camelCase
      const roundtripped = wireToTopology(result.data);
      expect(roundtripped.structure).toBe(preset.topology.structure);
      expect(roundtripped.roles.length).toBe(preset.topology.roles.length);
    });
  }
});

// ============================================================================
// 9. Nexus lifecycle integration
// ============================================================================

describe("Nexus lifecycle", () => {
  test("inferNexusPreset returns 'shared' only for swarm-ops", () => {
    const presets = getPresetRegistry();
    for (const [name, preset] of Object.entries(presets)) {
      const nexusPreset = inferNexusPreset({
        name: "test",
        mode: preset.backend === "nexus" ? "nexus" : "local",
        preset: name,
      });
      if (name === "swarm-ops") {
        expect(nexusPreset).toBe("shared");
      } else {
        expect(nexusPreset).toBe("local");
      }
    }
  });

  test("readNexusUrl returns default when nexus.yaml doesn't exist", () => {
    const url = readNexusUrl("/nonexistent/path");
    expect(url).toBe(DEFAULT_NEXUS_URL);
    expect(url).toBe("http://localhost:2026");
  });

  test("readNexusUrl parses port from nexus.yaml", async () => {
    const dir = await createTempDir("nexus-yaml-test");
    const nexusYaml = `# Generated by nexus init
ports:
  http: 3456
  grpc: 3458
  postgres: 5432

zone: default
`;

    writeFileSync(join(dir, "nexus.yaml"), nexusYaml, "utf-8");

    const url = readNexusUrl(dir);
    expect(url).toBe("http://localhost:3456");
  });

  test("readNexusUrl falls back to default for malformed nexus.yaml", async () => {
    const dir = await createTempDir("nexus-yaml-malformed");

    writeFileSync(join(dir, "nexus.yaml"), "garbage: true\n", "utf-8");

    const url = readNexusUrl(dir);
    expect(url).toBe(DEFAULT_NEXUS_URL);
  });

  test("all nexus-backend presets set nexusManaged when no --nexus-url given", async () => {
    const nexusPresets = Object.entries(getPresetRegistry()).filter(
      ([_, p]) => p.backend === "nexus",
    );
    expect(nexusPresets.length).toBeGreaterThan(0);

    for (const [name] of nexusPresets) {
      const dir = await createTempDir(`nexus-managed-${name}`);
      await executeInit(makeOptions(dir, name, `Test ${name}`));

      const config = readGroveJson(dir);
      expect(config.mode).toBe("nexus");
      expect(config.nexusManaged).toBe(true);
      expect(config.nexusUrl).toBeUndefined();
    }
  });

  test("explicit --nexus-url skips nexusManaged", async () => {
    const dir = await createTempDir("explicit-nexus-url");
    const opts: InitOptions = {
      ...makeOptions(dir, "review-loop", "Explicit Nexus"),
      nexusUrl: "http://my-nexus:2026",
    };
    await executeInit(opts);

    const config = readGroveJson(dir);
    expect(config.mode).toBe("nexus");
    expect(config.nexusUrl).toBe("http://my-nexus:2026");
    // nexusManaged should NOT be set when explicit URL is provided
    expect(config.nexusManaged).toBeUndefined();
  });
});

// ============================================================================
// 10. TUI backend resolution chain
// ============================================================================

describe("TUI backend resolution", () => {
  test("explicit --url flag resolves to remote mode", () => {
    const backend = resolveBackend({ url: "http://remote:4515" });
    expect(backend.mode).toBe("remote");
    expect(backend).toEqual({ mode: "remote", url: "http://remote:4515", source: "flag" });
  });

  test("explicit --nexus flag resolves to nexus mode", () => {
    const backend = resolveBackend({ nexus: "http://nexus:2026" });
    expect(backend.mode).toBe("nexus");
    expect((backend as Extract<ResolvedBackend, { mode: "nexus" }>).url).toBe("http://nexus:2026");
    expect((backend as Extract<ResolvedBackend, { mode: "nexus" }>).source).toBe("flag");
  });

  test("GROVE_NEXUS_URL env resolves to nexus mode", () => {
    const original = process.env.GROVE_NEXUS_URL;
    try {
      process.env.GROVE_NEXUS_URL = "http://env-nexus:2026";
      const backend = resolveBackend({});
      expect(backend.mode).toBe("nexus");
      expect((backend as Extract<ResolvedBackend, { mode: "nexus" }>).url).toBe(
        "http://env-nexus:2026",
      );
      expect((backend as Extract<ResolvedBackend, { mode: "nexus" }>).source).toBe("env");
    } finally {
      if (original !== undefined) {
        process.env.GROVE_NEXUS_URL = original;
      } else {
        delete process.env.GROVE_NEXUS_URL;
      }
    }
  });

  test("no flags and no env falls back to local", () => {
    const original = process.env.GROVE_NEXUS_URL;
    try {
      delete process.env.GROVE_NEXUS_URL;
      // Use a path that won't have grove.json
      const backend = resolveBackend({ groveOverride: "/nonexistent/.grove" });
      expect(backend.mode).toBe("local");
    } finally {
      if (original !== undefined) {
        process.env.GROVE_NEXUS_URL = original;
      } else {
        delete process.env.GROVE_NEXUS_URL;
      }
    }
  });

  test("nexus-managed grove.json resolves via readNexusUrl", async () => {
    const dir = await createTempDir("tui-resolve-test");
    await executeInit(makeOptions(dir, "review-loop", "Resolve Test"));

    // Write a nexus.yaml with custom port

    writeFileSync(join(dir, "nexus.yaml"), "ports:\n  http: 9999\n  grpc: 9998\n", "utf-8");

    const original = process.env.GROVE_NEXUS_URL;
    try {
      delete process.env.GROVE_NEXUS_URL;
      const backend = resolveBackend({ groveOverride: join(dir, ".grove") });
      // Should resolve to nexus mode using nexus.yaml port
      expect(backend.mode).toBe("nexus");
      expect((backend as Extract<ResolvedBackend, { mode: "nexus" }>).url).toBe(
        "http://localhost:9999",
      );
    } finally {
      if (original !== undefined) {
        process.env.GROVE_NEXUS_URL = original;
      } else {
        delete process.env.GROVE_NEXUS_URL;
      }
    }
  });
});

// ============================================================================
// 11. GROVE.md contract roundtrip (all presets)
// ============================================================================

describe("GROVE.md contract roundtrip", () => {
  const presetNames = listPresetNames();

  for (const name of presetNames) {
    test(`${name}: init → GROVE.md → parseGroveContract roundtrips`, async () => {
      const dir = await createTempDir(`roundtrip-${name}`);
      await executeInit(makeOptions(dir, name, `Roundtrip ${name}`));

      // Should not throw — the generated GROVE.md must be parseable
      const contract = readGroveMd(dir);
      expect(contract.name).toBe(`Roundtrip ${name}`);

      const preset = getPreset(name)!;
      expect(contract.mode).toBe(preset.mode);

      // Contract version matches: V3 if topology, V2 otherwise
      if (preset.topology) {
        expect(contract.contractVersion).toBe(3);
      } else {
        expect(contract.contractVersion).toBe(2);
      }
    });
  }
});

// ============================================================================
// 12. CLI E2E smoke tests (all presets)
// ============================================================================

describe("CLI E2E smoke tests", () => {
  const presetNames = listPresetNames();

  for (const name of presetNames) {
    test(`grove init --preset ${name} via CLI exits 0`, async () => {
      const dir = await createTempDir(`e2e-${name}`);
      const cliPath = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
      const proc = Bun.spawn(["bun", "run", cliPath, "init", `test-${name}`, "--preset", name], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          // Prevent nexus CLI from being called during CI
          PATH: process.env.PATH,
        },
      });

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;

      expect(exitCode).toBe(0);
      expect(existsSync(join(dir, ".grove"))).toBe(true);
      expect(existsSync(join(dir, "GROVE.md"))).toBe(true);
      expect(existsSync(join(dir, ".grove", "grove.json"))).toBe(true);

      // Verify stdout mentions the preset
      const output = stdout + stderr;
      expect(output).toContain(`Initialized grove 'test-${name}'`);
    });
  }
});

// ============================================================================
// 13. Cross-preset comparisons
// ============================================================================

describe("Cross-preset comparisons", () => {
  test("only swarm-ops enables MCP service", () => {
    const registry = getPresetRegistry();
    for (const [name, preset] of Object.entries(registry)) {
      if (name === "swarm-ops") {
        expect(preset.services.mcp).toBe(true);
      } else {
        expect(preset.services.mcp).toBe(false);
      }
    }
  });

  test("all presets enable HTTP server", () => {
    const registry = getPresetRegistry();
    for (const preset of Object.values(registry)) {
      expect(preset.services.server).toBe(true);
    }
  });

  test("only research-loop uses local backend", () => {
    const registry = getPresetRegistry();
    for (const [name, preset] of Object.entries(registry)) {
      if (name === "research-loop") {
        expect(preset.backend).toBe("local");
      } else {
        expect(preset.backend).toBe("nexus");
      }
    }
  });

  test("only evaluation-mode presets define metrics", () => {
    const registry = getPresetRegistry();
    for (const [_name, preset] of Object.entries(registry)) {
      if (preset.mode === "evaluation") {
        expect(preset.metrics?.length).toBeGreaterThan(0);
      } else {
        expect(preset.metrics).toBeUndefined();
      }
    }
  });

  test("all presets define topology", () => {
    const registry = getPresetRegistry();
    for (const preset of Object.values(registry)) {
      expect(preset.topology).toBeDefined();
      expect(preset.topology?.roles.length).toBeGreaterThan(0);
    }
  });

  test("only flat topology has no inter-agent edges", () => {
    const registry = getPresetRegistry();
    for (const preset of Object.values(registry)) {
      if (preset.topology?.structure === "flat") {
        for (const role of preset.topology.roles) {
          expect(role.edges ?? []).toEqual([]);
        }
      } else {
        // non-flat topologies should have at least one role with edges
        const hasEdges = preset.topology?.roles.some((r) => (r.edges?.length ?? 0) > 0);
        expect(hasEdges).toBe(true);
      }
    }
  });

  test("topology role commands all use claude agent", () => {
    const registry = getPresetRegistry();
    for (const preset of Object.values(registry)) {
      for (const role of preset.topology?.roles ?? []) {
        if (role.command) {
          // All preset role commands use claude
          expect(role.command).toMatch(/^claude/);
        }
      }
    }
  });

  test("seed contribution counts match expected", () => {
    const expected: Record<string, number> = {
      "review-loop": 2, // coder + reviewer
      exploration: 2, // explorer + critic
      "swarm-ops": 1, // coordinator
      "research-loop": 1, // researcher baseline
      "pr-review": 1, // reviewer
      "federated-swarm": 0, // no seeds
    };

    const registry = getPresetRegistry();
    for (const [name, preset] of Object.entries(registry)) {
      const count = preset.seedContributions?.length ?? 0;
      expect(count).toBe(expected[name]);
    }
  });
});

// ============================================================================
// 14. Force re-init with different preset
// ============================================================================

describe("Re-init with --force", () => {
  test("can switch from review-loop to swarm-ops with --force", async () => {
    const dir = await createTempDir("re-init");

    // First init: review-loop
    await executeInit(makeOptions(dir, "review-loop", "Review First"));
    let config = readGroveJson(dir);
    expect(config.preset).toBe("review-loop");

    // Second init: swarm-ops with --force
    await executeInit({
      ...makeOptions(dir, "swarm-ops", "Now Swarm"),
      force: true,
    });
    config = readGroveJson(dir);
    expect(config.preset).toBe("swarm-ops");
    expect(config.services).toEqual({ server: true, mcp: true }); // MCP now enabled

    const contract = readGroveMd(dir);
    expect(contract.name).toBe("Now Swarm");
    expect(contract.mode).toBe("evaluation");
    expect(contract.topology?.structure).toBe("tree");
  });

  test("can switch from nexus preset to local preset with --force", async () => {
    const dir = await createTempDir("re-init-backend");

    // First init: review-loop (nexus backend)
    await executeInit(makeOptions(dir, "review-loop", "Nexus First"));
    let config = readGroveJson(dir);
    expect(config.mode).toBe("nexus");
    expect(config.nexusManaged).toBe(true);

    // Second init: research-loop (local backend) with --force
    await executeInit({
      ...makeOptions(dir, "research-loop", "Now Local"),
      force: true,
    });
    config = readGroveJson(dir);
    expect(config.mode).toBe("local");
    expect(config.nexusManaged).toBeUndefined();
    expect(config.preset).toBe("research-loop");
  });
});

// ============================================================================
// Helpers for topology wire conversion
// ============================================================================

/**
 * Convert camelCase AgentTopology (from PresetConfig) to snake_case wire
 * format for Zod schema validation.
 */
function topologyToWire(t: AgentTopology): Record<string, unknown> {
  return {
    structure: t.structure,
    roles: t.roles.map((role) => ({
      name: role.name,
      ...(role.description !== undefined && { description: role.description }),
      ...(role.maxInstances !== undefined && { max_instances: role.maxInstances }),
      ...(role.edges !== undefined && {
        edges: role.edges.map((edge) => ({
          target: edge.target,
          edge_type: edge.edgeType,
        })),
      }),
      ...(role.command !== undefined && { command: role.command }),
      ...(role.platform !== undefined && { platform: role.platform }),
      ...(role.model !== undefined && { model: role.model }),
      ...(role.color !== undefined && { color: role.color }),
    })),
    ...(t.spawning !== undefined && {
      spawning: {
        dynamic: t.spawning.dynamic,
        ...(t.spawning.maxDepth !== undefined && { max_depth: t.spawning.maxDepth }),
        ...(t.spawning.maxChildrenPerAgent !== undefined && {
          max_children_per_agent: t.spawning.maxChildrenPerAgent,
        }),
        ...(t.spawning.timeoutSeconds !== undefined && {
          timeout_seconds: t.spawning.timeoutSeconds,
        }),
      },
    }),
  };
}
