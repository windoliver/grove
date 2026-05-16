/**
 * Real-process E2E harness for the Supervision screen (#193).
 *
 * Spins up `grove up` in a dedicated tmux session, registers a few agents,
 * induces a pending approval, screenshots the supervision surface, presses
 * `A` then `y` to accept, and screenshots again to verify the card transitions
 * back to running.
 *
 * Convention (per project memory `feedback_real_process_e2e`): wire-protocol
 * changes need this layer — in-process tests are not enough.
 *
 * Run manually:
 *   bun run tests/e2e/supervision-real-grove.ts          # auto-cleanup
 *   bun run tests/e2e/supervision-real-grove.ts --keep   # preserve tmux session on exit
 *
 * NOTE: This is currently a SKELETON. The full body is deferred to the
 * follow-up that wires the supervision surface to a live grove session.
 * Sibling reference: tests/e2e/watch-relist-tmux.ts.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEEP = process.argv.includes("--keep");

interface HarnessContext {
  readonly workdir: string;
  readonly tmuxSession: string;
}

async function setup(): Promise<HarnessContext> {
  const workdir = await mkdtemp(join(tmpdir(), "grove-sup-e2e-"));
  const tmuxSession = `grove-sup-e2e-${Date.now()}`;
  // TODO: launch `grove up` inside the tmux session.
  //   - Inspect watch-relist-tmux.ts for the spawn pattern (tmux new-session -d, send-keys).
  //   - Confirm grove is on the PATH; if not, build first or document the prerequisite.
  return { workdir, tmuxSession };
}

async function teardown(ctx: HarnessContext): Promise<void> {
  if (KEEP) {
    console.log(
      `[harness] --keep set; preserving tmux session ${ctx.tmuxSession} and ${ctx.workdir}`,
    );
    return;
  }
  // TODO: kill the tmux session and clean up workdir.
  await rm(ctx.workdir, { recursive: true, force: true });
}

async function captureScreenshot(_ctx: HarnessContext, _label: string): Promise<string> {
  // TODO: tmux capture-pane -t <session> -p, return the captured text.
  return "";
}

async function sendKey(_ctx: HarnessContext, _key: string): Promise<void> {
  // TODO: tmux send-keys -t <session> <key>
}

async function main(): Promise<void> {
  const ctx = await setup();
  try {
    // 1. Register 3 agents (TODO: call grove CLI to register).
    // 2. Induce a pending tmux permission prompt on one agent.
    // 3. Capture screenshot — assert "APPR" / "⏸" badge present.
    // 4. sendKey(ctx, "A")  → opens approval modal.
    // 5. sendKey(ctx, "y")  → accepts.
    // 6. Capture screenshot — assert the badge has cleared.

    console.log("[harness] SKELETON: real-process e2e body not yet implemented");
    console.log("[harness] sibling reference: tests/e2e/watch-relist-tmux.ts");
    console.log(`[harness] workdir: ${ctx.workdir}`);
    console.log(`[harness] tmux session: ${ctx.tmuxSession}`);

    void captureScreenshot;
    void sendKey;
  } finally {
    await teardown(ctx);
  }
}

main().catch((err) => {
  console.error("[harness] failed:", err);
  process.exit(1);
});
