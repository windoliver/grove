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
          { target: "synthesizer", edgeType: "delegates" },
        ],
        command: "claude --role explorer",
      },
      {
        name: "critic",
        description: "Evaluates and challenges proposals",
        maxInstances: 2,
        edges: [
          { target: "explorer", edgeType: "feedback" },
          { target: "synthesizer", edgeType: "delegates" },
        ],
        command: "claude --role critic",
      },
      {
        name: "synthesizer",
        description: "Combines insights into coherent results",
        maxInstances: 1,
        edges: [{ target: "explorer", edgeType: "delegates" }],
        command: "claude --role synthesizer",
      },
    ],
    spawning: { dynamic: true, maxDepth: 3 },
  },
  concurrency: {
    maxActiveClaims: 6,
    maxClaimsPerAgent: 1,
  },
  seedContributions: [],
  services: { server: true, mcp: true },
  backend: "nexus",
  features: {
    askUser: { strategy: "interactive", perAgent: true },
  },
};
