/**
 * Visual test harness for TracePane — renders with mock data in a real terminal.
 *
 * Usage: bun run tests/tui/trace-pane-harness.tsx
 * Or via tmux: tmux new-session -d -s trace-test "bun run tests/tui/trace-pane-harness.tsx"
 *              tmux capture-pane -t trace-test -p
 */

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import React from "react";
import { AgentLogBuffer } from "../../src/tui/data/agent-log-buffer.js";
import { TracePane } from "../../src/tui/views/trace-pane.js";

// Create mock buffers with realistic data
const buffers = new Map<string, AgentLogBuffer>();

const coderBuf = new AgentLogBuffer("coder", "sess-visual-test");
const coderLines = [
  "[tool] Read src/auth.ts (completed)",
  "Found 3 issues in authentication flow",
  "[tool] Edit src/auth.ts (running)",
  "  Adding null check on line 42",
  "  Adding rate limit on login",
  "[tool] Run tests (pending)",
  "[IPC from reviewer] LGTM, merge it",
  "[done] end_turn",
  "Starting next task...",
  "[tool] Read src/api/routes.ts (completed)",
  "Reviewing API endpoint security",
  "Found missing CSRF protection on POST /api/users",
  "[tool] Edit src/api/routes.ts (running)",
  "  Adding CSRF middleware",
  "[done] end_turn",
];
for (const line of coderLines) {
  coderBuf.pushRawLines([line]);
}
buffers.set("coder", coderBuf);

const reviewerBuf = new AgentLogBuffer("reviewer", "sess-visual-test");
const reviewerLines = [
  "[tool] Read src/auth.ts (completed)",
  "Code looks correct, checking edge cases",
  "Null check on line 42 is correct",
  "[done] end_turn",
];
for (const line of reviewerLines) {
  reviewerBuf.pushRawLines([line]);
}
buffers.set("reviewer", reviewerBuf);

const analystBuf = new AgentLogBuffer("analyst", "sess-visual-test");
analystBuf.pushRawLines(["Analyzing codebase patterns...", "[tool] Search for auth patterns"]);
buffers.set("analyst", analystBuf);

const plannerBuf = new AgentLogBuffer("planner", "sess-visual-test");
buffers.set("planner", plannerBuf); // empty — no output yet

async function main() {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useAlternateScreen: false,
  });
  const root = createRoot(renderer);

  const roles = ["coder", "reviewer", "analyst", "planner"];
  const agentStatuses = new Map<string, string>([
    ["coder", "running"],
    ["reviewer", "idle"],
    ["analyst", "running"],
    ["planner", "idle"],
  ]);

  root.render(
    React.createElement(TracePane, {
      buffers,
      roles,
      agentStatuses,
      spinnerFrame: 3,
      selectedAgent: 0,
      traceScrollOffset: 0,
      viewportLines: 20,
    }),
  );

  renderer.start();
  await renderer.idle();

  // Keep alive for tmux capture
  await new Promise((r) => setTimeout(r, 10000));
  renderer.destroy();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
