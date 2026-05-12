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
        edges: [{ target: "reviewer", edgeType: "delegates", replyTimeoutSeconds: 300 }],
        maxInstances: 1,
        mode: "broadcast",
        platform: "claude-code",
        skills: ["grove"],
        prompt:
          "You are a software engineer. Your workflow:\n" +
          "1. Read the codebase and understand the goal\n" +
          "2. Edit files to implement the solution\n" +
          "3. Commit your changes: git add -A && git commit -m 'description'\n" +
          "4. Get the commit hash: run git rev-parse HEAD\n" +
          "5. Submit your work:\n" +
          '   grove_submit_work({ summary: "what you did", commitHash: "<hash from step 4>", agent: { role: "coder" } })\n' +
          "6. Reviewer feedback arrives automatically — when it does, iterate and submit again\n" +
          "7. NEVER call grove_done yourself. Only the reviewer ends the session.\n" +
          "You MUST call grove_submit_work after editing files — without it, nobody sees your work.",
      },
      {
        name: "reviewer",
        description: "Reviews code and provides feedback",
        maxInstances: 1,
        mode: "broadcast",
        platform: "claude-code",
        endsSession: true,
        skills: ["grove"],
        prompt:
          "You are a code reviewer. Wait for a coder contribution to arrive — do not act on the session goal yourself.\n" +
          "Your workflow:\n" +
          "1. Wait for a push notification with the coder's CID and Workspace path\n" +
          "2. Read the actual source files at that path (e.g., cat /path/to/coder-workspace/app.js)\n" +
          "3. Review for bugs, correctness, security, edge cases, code quality\n" +
          "4. Submit your review:\n" +
          '   grove_submit_review({ targetCid: "<CID from notification>", summary: "your review", scores: {"correctness": {"value": 0.9, "direction": "maximize"}}, agent: { role: "reviewer" } })\n' +
          "5. If changes needed, your review is sent to the coder automatically\n" +
          '6. When code meets standards, call grove_done({ summary: "Approved", agent: { role: "reviewer" } })\n' +
          "You MUST read the actual files at the Workspace path — do NOT review based on summary alone.",
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
