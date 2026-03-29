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
        command: "claude --role coordinator",
        prompt:
          "Loop: grove_frontier (survey state) → grove_list_claims → grove_read_inbox → " +
          "grove_create_plan/grove_update_plan → grove_send_message to delegate → " +
          "grove_check_stop → repeat.",
      },
      {
        name: "worker",
        description: "Executes assigned tasks",
        maxInstances: 5,
        command: "claude --role worker",
        prompt:
          "Loop: grove_frontier → grove_claim → grove_checkout → code → " +
          "grove_submit_work (with artifacts) → grove_read_inbox for feedback → repeat.",
      },
      {
        name: "qa",
        description: "Reviews and validates completed work",
        maxInstances: 2,
        command: "claude --role qa",
        prompt:
          "Loop: grove_frontier (find unreviewed work) → grove_claim → grove_checkout → " +
          "review → grove_submit_review (with quality scores) → grove_send_message if action " +
          "needed → repeat.",
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
  seedContributions: [],
  services: { server: true, mcp: true },
  backend: "nexus",
  features: {
    costTracking: true,
  },
};
