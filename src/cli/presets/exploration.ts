/**
 * Exploration preset — 3 roles (explorer, critic, synthesizer), exploration mode.
 *
 * An open-ended discovery workflow for researching solutions,
 * critiquing ideas, and synthesizing results.
 */

import type { PresetConfig } from "./index.js";

export const explorationPreset: PresetConfig = {
  name: "exploration",
  description: "Open-ended exploration with explorer, critic, and synthesizer",
  mode: "exploration",
  topology: {
    structure: "graph",
    roles: [
      {
        name: "explorer",
        description: "Proposes new ideas and approaches",
        maxInstances: 3,
        edges: [
          { target: "critic", edgeType: "delegates" },
          { target: "synthesizer", edgeType: "feeds" },
        ],
        command: "claude --role explorer",
      },
      {
        name: "critic",
        description: "Evaluates and challenges proposals",
        maxInstances: 2,
        edges: [
          { target: "explorer", edgeType: "feedback" },
          { target: "synthesizer", edgeType: "feeds" },
        ],
        command: "claude --role critic",
      },
      {
        name: "synthesizer",
        description: "Combines insights into coherent results",
        maxInstances: 1,
        edges: [{ target: "explorer", edgeType: "requests" }],
        command: "claude --role synthesizer",
      },
    ],
    spawning: { dynamic: true, maxDepth: 3 },
  },
  concurrency: {
    maxActiveClaims: 6,
    maxClaimsPerAgent: 1,
  },
  seedContributions: [
    {
      kind: "work",
      mode: "exploration",
      summary: "Initial problem statement and exploration space",
      tags: ["seed", "problem-statement"],
      agentId: "explorer-seed",
      role: "explorer",
    },
    {
      kind: "discussion",
      mode: "exploration",
      summary: "Key constraints and evaluation criteria",
      tags: ["seed", "constraints"],
      agentId: "critic-seed",
      role: "critic",
    },
  ],
  services: { server: true, mcp: false },
  backend: "nexus",
  features: {
    askUser: { strategy: "interactive", perAgent: true },
  },
};
