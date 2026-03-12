/**
 * Swarm ops preset — multi-role topology with claims/bounties, evaluation mode.
 *
 * A production-oriented setup for coordinating multiple agents on
 * measurable objectives with claim-based work assignment.
 */

import type { PresetConfig } from "./index.js";

export const swarmOpsPreset: PresetConfig = {
  name: "swarm-ops",
  description: "Multi-agent swarm with coordinator, workers, and QA",
  mode: "evaluation",
  metrics: [
    {
      name: "task_completion",
      direction: "maximize",
      description: "Percentage of tasks completed",
    },
    { name: "quality_score", direction: "maximize", description: "Quality review average score" },
  ],
  topology: {
    structure: "tree",
    roles: [
      {
        name: "coordinator",
        description: "Assigns work and monitors progress",
        maxInstances: 1,
        edges: [
          { target: "worker", edgeType: "delegates" },
          { target: "qa", edgeType: "delegates" },
        ],
      },
      {
        name: "worker",
        description: "Executes assigned tasks",
        maxInstances: 5,
        edges: [{ target: "coordinator", edgeType: "reports" }],
      },
      {
        name: "qa",
        description: "Reviews and validates completed work",
        maxInstances: 2,
        edges: [{ target: "coordinator", edgeType: "reports" }],
      },
    ],
    spawning: { dynamic: true, maxDepth: 2, maxChildrenPerAgent: 5 },
  },
  gates: [{ type: "has_relation", relation_type: "derives_from" }],
  stopConditions: {
    budget: { maxContributions: 200 },
  },
  concurrency: {
    maxActiveClaims: 8,
    maxClaimsPerAgent: 2,
  },
  execution: {
    defaultLeaseSeconds: 600,
    maxLeaseSeconds: 1800,
    heartbeatIntervalSeconds: 120,
    stallTimeoutSeconds: 300,
  },
  seedContributions: [
    {
      kind: "work",
      mode: "evaluation",
      summary: "Project setup and initial task breakdown",
      tags: ["seed", "setup"],
      agentId: "coordinator-seed",
      role: "coordinator",
    },
  ],
  services: { server: true, mcp: true },
  backend: "nexus",
};
