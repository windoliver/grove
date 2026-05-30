/**
 * Eval-loop preset — Hive-style competitive benchmark.
 *
 * A flat topology of up to 8 competitors that each iterate to improve a
 * single `score` metric. The `hooks.eval` placeholder is filled in by a
 * benchmark script; `grove eval --submit` records scored reproductions that
 * feed the frontier leaderboard. Tuned for long-running benchmarks with a
 * high contribution/wall-clock budget.
 */

import type { PresetConfig } from "./index.js";

export const evalLoopPreset: PresetConfig = {
  name: "eval-loop",
  description: "Competitive benchmark loop with score:maximize and an eval hook",
  mode: "evaluation",
  metrics: [
    {
      name: "score",
      direction: "maximize",
      description: "Benchmark score reported by the eval harness",
    },
  ],
  topology: {
    structure: "flat",
    roles: [
      {
        name: "competitor",
        description: "Iterates on the artifact to improve the benchmark score",
        maxInstances: 8,
        command: "claude --role competitor",
        platform: "claude-code",
      },
    ],
    spawning: { dynamic: true, maxDepth: 1 },
  },
  gates: [{ type: "metric_improves", metric: "score" }],
  stopConditions: {
    maxRoundsWithoutImprovement: 20,
    targetMetric: { metric: "score", value: 1.0 },
    budget: { maxContributions: 2000, maxWallClockSeconds: 86400 },
  },
  concurrency: {
    maxActiveClaims: 8,
    maxClaimsPerAgent: 1,
  },
  execution: {
    defaultLeaseSeconds: 600,
    maxLeaseSeconds: 3600,
  },
  // Placeholder benchmark harness — replace eval/eval.sh with a script that
  // prints `GROVE_SCORE score=<value>` to stdout.
  hooks: { eval: "bash eval/eval.sh" },
  seedContributions: [],
  services: { server: true, mcp: true },
  backend: "nexus",
  features: {
    costTracking: true,
    messaging: true,
  },
};
