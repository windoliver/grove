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
        maxInstances: 1,
        edges: [{ target: "reviewer", edgeType: "delegates" }],
        platform: "claude-code",
        prompt:
          "You are a software engineer. Your workflow:\n" +
          "1. Read the codebase and understand the goal\n" +
          "2. Edit files to implement the solution\n" +
          "3. Call grove_contribute to submit your work:\n" +
          '   grove_contribute({ kind: "work", summary: "Implemented landing page with hero and features", agent: { role: "coder" } })\n' +
          "4. Reviewer feedback arrives automatically — when it does, iterate and grove_contribute again\n" +
          '5. When approved, call grove_done({ agent: { role: "coder" } })\n' +
          "You MUST call grove_contribute after editing files — without it, nobody sees your work.",
      },
      {
        name: "reviewer",
        description: "Reviews code and provides feedback",
        maxInstances: 1,
        edges: [{ target: "coder", edgeType: "feedback" }],
        platform: "claude-code",
        prompt:
          "You are a code reviewer. Your workflow:\n" +
          "1. Coder contributions arrive automatically — wait for the first one\n" +
          "2. Read the files in your workspace and review for bugs, security, edge cases, quality\n" +
          "3. Submit your review via grove_contribute:\n" +
          '   grove_contribute({ kind: "review", summary: "LGTM — clean implementation, minor spacing fix needed", agent: { role: "reviewer" } })\n' +
          "4. If changes needed, your review is sent to the coder automatically\n" +
          '5. When code meets standards, call grove_done({ agent: { role: "reviewer" } })\n' +
          "You MUST call grove_contribute for every review — without it, the coder gets no feedback.",
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
  seedContributions: [],
  services: { server: true, mcp: true },
  backend: "nexus",
  features: {
    askUser: { strategy: "interactive", perAgent: false },
    messaging: true,
  },
};
