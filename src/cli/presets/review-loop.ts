/**
 * Review loop preset — 2 roles (coder + reviewer), exploration mode.
 *
 * A simple code review workflow where a coder submits work and a
 * reviewer provides feedback in a continuous loop.
 */

import type { PresetConfig } from "./index.js";

export const reviewLoopPreset: PresetConfig = {
  name: "review-loop",
  description: "Code review loop with coder and reviewer roles",
  mode: "exploration",
  topology: {
    structure: "graph",
    roles: [
      {
        name: "coder",
        description: "Writes and iterates on code",
        maxInstances: 2,
        edges: [{ target: "reviewer", edgeType: "delegates" }],
        command: "claude --role coder",
      },
      {
        name: "reviewer",
        description: "Reviews code and provides feedback",
        maxInstances: 2,
        edges: [{ target: "coder", edgeType: "feedback" }],
        command: "claude --role reviewer",
      },
    ],
    spawning: { dynamic: true, maxDepth: 2 },
  },
  concurrency: {
    maxActiveClaims: 4,
    maxClaimsPerAgent: 1,
  },
  execution: {
    defaultLeaseSeconds: 300,
    maxLeaseSeconds: 900,
  },
  seedContributions: [
    {
      kind: "work",
      mode: "exploration",
      summary: "Initial implementation scaffold",
      tags: ["seed", "scaffold"],
      agentId: "coder-seed",
      role: "coder",
    },
    {
      kind: "review",
      mode: "exploration",
      summary: "Review: architecture looks solid, add error handling",
      tags: ["seed", "review"],
      agentId: "reviewer-seed",
      role: "reviewer",
    },
  ],
  services: { server: true, mcp: false },
  backend: "nexus",
  features: {
    askUser: { strategy: "interactive", perAgent: false },
    messaging: true,
  },
};
