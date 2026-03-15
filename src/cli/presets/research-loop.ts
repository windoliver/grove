/**
 * Research loop preset — benchmark-driven, evaluation mode with val_bpb.
 *
 * Designed for ML research workflows where agents iterate to improve
 * a numeric benchmark metric.
 */

import type { PresetConfig } from "./index.js";

export const researchLoopPreset: PresetConfig = {
  name: "research-loop",
  description: "Benchmark-driven research loop with val_bpb:minimize",
  mode: "evaluation",
  metrics: [
    {
      name: "val_bpb",
      direction: "minimize",
      unit: "bpb",
      description: "Validation bits-per-byte",
    },
  ],
  topology: {
    structure: "graph",
    roles: [
      {
        name: "researcher",
        description: "Proposes and implements improvements",
        maxInstances: 3,
        edges: [{ target: "evaluator", edgeType: "delegates" }],
        command: "claude --role researcher",
      },
      {
        name: "evaluator",
        description: "Runs benchmarks and reports results",
        maxInstances: 2,
        edges: [{ target: "researcher", edgeType: "feedback" }],
        command: "claude --role evaluator",
      },
    ],
    spawning: { dynamic: true, maxDepth: 2 },
  },
  gates: [{ type: "metric_improves", metric: "val_bpb" }],
  stopConditions: {
    maxRoundsWithoutImprovement: 10,
    targetMetric: { metric: "val_bpb", value: 0.95 },
    budget: { maxContributions: 500, maxWallClockSeconds: 7200 },
  },
  concurrency: {
    maxActiveClaims: 5,
    maxClaimsPerAgent: 1,
  },
  execution: {
    defaultLeaseSeconds: 600,
    maxLeaseSeconds: 3600,
  },
  seedContributions: [
    {
      kind: "work",
      mode: "evaluation",
      summary: "Baseline model with initial val_bpb measurement",
      tags: ["seed", "baseline"],
      agentId: "researcher-seed",
      role: "researcher",
    },
  ],
  services: { server: true, mcp: false },
  backend: "local",
  features: {
    askUser: { strategy: "interactive", perAgent: true },
    costTracking: true,
    messaging: true,
  },
};
