/**
 * PR review preset — GitHub PR review with multi-agent code analysis.
 *
 * A review workflow where reviewers analyze PR changes and analysts
 * deep-dive into specific files or patterns.
 */

import type { PresetConfig } from "./index.js";

export const prReviewPreset: PresetConfig = {
  name: "pr-review",
  description: "GitHub PR review with multi-agent code analysis",
  mode: "exploration",
  topology: {
    structure: "graph",
    roles: [
      {
        name: "reviewer",
        description: "Reviews PR code changes and provides feedback",
        maxInstances: 3,
        edges: [{ target: "analyst", edgeType: "delegates" }],
        command: "claude --role reviewer",
        platform: "claude-code",
      },
      {
        name: "analyst",
        description: "Deep-dives into specific files or patterns",
        maxInstances: 2,
        edges: [{ target: "reviewer", edgeType: "delegates" }],
        command: "claude --role analyst",
        platform: "claude-code",
      },
    ],
    spawning: { dynamic: true, maxDepth: 2 },
  },
  concurrency: {
    maxActiveClaims: 5,
    maxClaimsPerAgent: 1,
  },
  execution: {
    defaultLeaseSeconds: 300,
    maxLeaseSeconds: 600,
  },
  seedContributions: [],
  services: { server: true, mcp: true },
  backend: "nexus",
  features: {
    github: { autoDetectPR: true },
    askUser: { strategy: "interactive", perAgent: true },
    costTracking: true,
    messaging: true,
  },
};
