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
        command: "claude --allowedTools 'mcp__grove__*'",
        prompt:
          "Loop: grove_wait_for_event (blocks until new work/messages arrive) → " +
          "grove_frontier → grove_claim → grove_checkout → code → " +
          "grove_contribute (kind=work) → repeat. " +
          "Use grove_wait_for_event instead of polling grove_read_inbox — " +
          "it returns new contributions and inbox messages as soon as they appear.",
      },
      {
        name: "reviewer",
        description: "Reviews code and provides feedback",
        maxInstances: 1,
        edges: [{ target: "coder", edgeType: "feedback" }],
        command: "codex --full-auto",
        prompt:
          "Loop: grove_wait_for_event(kind='work') (blocks until new work arrives) → " +
          "grove_claim → grove_checkout → review → grove_review (with quality scores) → " +
          "grove_send_message to coder if action needed → repeat. " +
          "Use grove_wait_for_event instead of polling — it notifies you instantly " +
          "when the coder submits new work.",
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
