/**
 * Tmux-driven E2E for the C6 confirm-and-mutate operator flow (#304).
 *
 * Validates the wire-protocol round trip through the modal:
 *   1. Spawn a real grove-server in tmux pane 0.
 *   2. In tmux pane 1, run a Bun driver that mounts <ConfirmAndMutateProvider>
 *      against a real RemoteDataProvider pointed at the server, creates a
 *      session, opens the modal, dispatches 'y' through the captured
 *      keyboard handler, and asserts the server-side session is archived.
 *
 * Mirrors `tests/e2e/watch-relist-tmux.ts`: a thin outer driver that owns
 * the tmux session, server lifecycle, and pane scrape, plus a written-out
 * inner driver script that exercises the protocol.
 *
 * NOT wired into `bun test` — run as:
 *   bun run tests/e2e/confirm-and-mutate.tmux.ts
 *
 * Flags:
 *   --keep          Leave tmux session + workdir for inspection
 *   --attach        Print `tmux attach` command and wait
 *   --timeout <ms>  Overall budget (default 60000)
 *
 * Exit code: 0 on success, 1 on any phase failure.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";

// ─── Paths ────────────────────────────────────────────────────────────────────

const SOCKET = "grove-confirm-mutate-e2e";
const SESSION = "grove-confirm-mutate-e2e";
const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const SERVER_PORT = 12794;

// ─── Args ─────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    keep: { type: "boolean", default: false },
    attach: { type: "boolean", default: false },
    timeout: { type: "string", default: "60000" },
  },
});
const KEEP = values.keep;
const ATTACH = values.attach;
const BUDGET_MS = Number.parseInt(values.timeout as string, 10);

// ─── tmux helpers ─────────────────────────────────────────────────────────────

function capturePane(target = SESSION): string {
  const out = spawnSync("tmux", ["-L", SOCKET, "capture-pane", "-t", target, "-p", "-S", "-5000"], {
    encoding: "utf-8",
  });
  return out.stdout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPane(
  predicate: (pane: string) => boolean,
  phase: string,
  maxMs = 30000,
  target = SESSION,
): Promise<string> {
  const deadline = Date.now() + maxMs;
  let last = "";
  while (Date.now() < deadline) {
    last = capturePane(target);
    if (predicate(last)) {
      console.log(`[${phase}] matched`);
      return last;
    }
    await sleep(500);
  }
  console.error(`\n──── pane dump (${phase}) ────`);
  console.error(last);
  console.error("──── end pane dump ────\n");
  throw new Error(`[${phase}] predicate did not match within ${maxMs}ms`);
}

// ─── Setup ────────────────────────────────────────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), "grove-confirm-mutate-"));
const groveDir = join(workDir, ".grove");
console.log(`[setup] workDir=${workDir}`);

// Track the driver test file so cleanup can delete it (it lives inside the
// project tree so node_modules resolution works — see comment in main()).
let driverPathToCleanup: string | undefined;

function cleanup() {
  try {
    execSync(`tmux -L ${SOCKET} kill-server 2>/dev/null`, { stdio: "ignore" });
  } catch {
    /* already dead */
  }
  if (driverPathToCleanup && existsSync(driverPathToCleanup) && !KEEP) {
    try {
      rmSync(driverPathToCleanup);
    } catch {
      /* best-effort */
    }
  }
  if (!KEEP && existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  } else if (KEEP) {
    console.log(`[cleanup] kept workDir=${workDir} (--keep)`);
    if (driverPathToCleanup) {
      console.log(`[cleanup] kept driverPath=${driverPathToCleanup} (--keep)`);
    }
  }
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

// ─── Driver test (written to a temp .test.ts file run via `bun test`) ─────────
//
// The driver is a standalone bun:test file because `mock.module` from
// bun:test is the cleanest way to intercept `@opentui/react` and capture
// `useKeyboard` handlers — mirroring the unit test in
// `src/tui/safety/confirm-and-mutate.test.tsx`. Rolling our own loader
// hook would duplicate that infrastructure.
//
// What it does:
//   1. Stubs @opentui/react so the provider's useKeyboard captures handlers.
//   2. Mounts <ConfirmAndMutateProvider> + a Caller via TestRenderer.
//   3. Creates a session via the real RemoteDataProvider against grove-server.
//   4. Triggers the modal with the session entity snapshot.
//   5. Dispatches 'y' through the captured handler.
//   6. Asserts the modal resolved ok AND the server reports the session as
//      archived (HTTP GET /api/sessions/:id → status === "archived").

function makeDriverTest(projectRoot: string): string {
  return `
/**
 * confirm-and-mutate E2E driver (run via \`bun test\` inside the tmux pane).
 * Generated by tests/e2e/confirm-and-mutate.tmux.ts — DO NOT edit by hand.
 */

import { describe, expect, mock, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type KeyboardKey = { readonly name?: string | undefined };
type KeyboardHandler = (key: KeyboardKey) => void;
const handlers: KeyboardHandler[] = [];

mock.module("@opentui/react", () => ({
  useKeyboard: (h: KeyboardHandler): void => { handlers.push(h); },
  useRenderer: (): { destroy: () => void } => ({ destroy: () => undefined }),
  useTerminalDimensions: (): { width: number; height: number } => ({ width: 120, height: 40 }),
  useTimeline: (): { add: () => unknown; play: () => unknown } => ({
    add: () => ({ add: () => ({ play: () => undefined }), play: () => undefined }),
    play: () => undefined,
  }),
}));

const { ConfirmAndMutateProvider, useConfirmAndMutate } = await import(
  "${projectRoot}/src/tui/safety/index.js"
);
const { RemoteDataProvider } = await import("${projectRoot}/src/tui/remote-provider.js");

describe("confirm-and-mutate tmux E2E", () => {
  test(
    "operator-confirmed archive round-trips through grove-server",
    async () => {
      const baseUrl = process.env.GROVE_BASE_URL ?? "http://localhost:${SERVER_PORT}";
      const token   = process.env.GROVE_TOKEN ?? "";
      if (!token) throw new Error("GROVE_TOKEN env var required");

      const provider = new RemoteDataProvider(baseUrl, { apiKey: token });
      const session = await provider.createSession({
        goal: "confirm-and-mutate-smoke",
        presetName: "review-loop",
      });
      console.log("[driver] created session id=" + session.id);

      // The HTTP toSessionResponse mapper currently drops resourceVersion,
      // so the client snapshot starts at "0". The modal's 409-retry loop
      // handles the stale-RV case automatically: first 'y' → 409 with the
      // server's current RV → snapshot bumped → retry on the next 'y'.
      // We dispatch 'y' twice with a wait between, mirroring the operator
      // pattern of ack the modal, see banner, ack again.
      const entity = {
        kind: "AgentSession" as const,
        namespace: "default",
        id: session.id,
        spec: { role: "session" },
        status: { phase: "running" as const },
        conditions: [],
        observedGeneration: 0,
        resourceVersion: String(session.resourceVersion ?? 0),
        metadata: { generation: 1 },
      };

      const bus = { get: () => undefined, subscribe: () => () => undefined };

      let triggerRef:
        | ((req: unknown) => Promise<{ ok: boolean; reason?: string }>)
        | null = null;
      function Caller(): null {
        triggerRef = useConfirmAndMutate() as unknown as typeof triggerRef;
        return null;
      }

      let tree: TestRenderer.ReactTestRenderer | undefined;
      await act(async () => {
        tree = TestRenderer.create(
          React.createElement(
            ConfirmAndMutateProvider,
            { entityBus: bus },
            React.createElement(Caller),
          ),
        );
      });
      if (!triggerRef) throw new Error("useConfirmAndMutate did not return a trigger");

      const dispatch = (name: string): void => {
        const latest = handlers[handlers.length - 1];
        if (!latest) throw new Error("no keyboard handler registered");
        latest({ name });
      };

      // Spin up the trigger; the promise resolves once the modal closes.
      let result: { ok: boolean; reason?: string } | undefined;
      let attempts = 0;
      const wrappedMutation = (t: { ifMatch: string; id: string }) => {
        attempts++;
        console.log("[driver] mutation attempt " + attempts + " ifMatch=" + t.ifMatch);
        return provider.archiveSession(t);
      };

      await act(async () => {
        const p = triggerRef!({
          entity,
          message: "Archive session before going back?",
          dangerous: true,
          mutation: wrappedMutation,
        });

        // Up to 4 attempts (matches the modal's MAX_RETRIES + 1). After
        // each 'y' we yield to let the HTTP request settle and the modal
        // either close (resolve) or re-open with a fresh snapshot.
        for (let i = 0; i < 4; i++) {
          // Yield so the modal mounts (first iteration) or re-renders post-409.
          await new Promise((r) => setTimeout(r, 100));
          dispatch("y");
          // Yield so the mutation settles and the modal either closes or
          // updates its snapshot for the next retry.
          await new Promise((r) => setTimeout(r, 200));
        }
        result = await p;
      });
      console.log("[driver] modal result=" + JSON.stringify(result) + " attempts=" + attempts);
      expect(result?.ok).toBe(true);
      expect(attempts).toBeGreaterThan(0);

      // Server-side: session must be archived.
      const verifyResp = await fetch(
        baseUrl + "/api/sessions/" + encodeURIComponent(session.id),
        { headers: { Authorization: "Bearer " + token } },
      );
      expect(verifyResp.ok).toBe(true);
      const verified = await verifyResp.json();
      console.log(
        "[driver] server-side session status=" + (verified as { status?: string }).status,
      );
      expect((verified as { status?: string }).status).toBe("archived");

      tree?.unmount();
      console.log("[smoke] OK");
    },
    { timeout: 30000 },
  );
});
`;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Kill any leftover tmux socket
  try {
    execSync(`tmux -L ${SOCKET} kill-server 2>/dev/null`, { stdio: "ignore" });
  } catch {
    /* already dead */
  }

  // 1. Init grove inside workDir (creates .grove/server-keys.yaml, api-key, project-id)
  console.log("[setup] grove init --preset review-loop");
  mkdirSync(workDir, { recursive: true });
  execSync(
    `GROVE_DIR=${groveDir} bun run ${join(PROJECT_ROOT, "src/cli/main.ts")} init --preset review-loop --force confirm-mutate-smoke`,
    { cwd: workDir, stdio: "inherit" },
  );

  // 2. Read bearer token from .grove/server-keys.yaml
  const serverKeysPath = join(groveDir, "server-keys.yaml");
  if (!existsSync(serverKeysPath)) {
    throw new Error(`server-keys.yaml not found at ${serverKeysPath}`);
  }
  const rawYaml = readFileSync(serverKeysPath, "utf8");
  const keysFile = parseYaml(rawYaml) as {
    version: number;
    keys: Record<string, { namespace: string; createdAt: string }>;
  };
  const token = Object.keys(keysFile.keys)[0];
  if (!token) throw new Error("No bearer token found in server-keys.yaml");
  console.log(`[setup] token=${token.slice(0, 8)}... (first 8 chars)`);

  const baseUrl = `http://localhost:${SERVER_PORT}`;
  console.log(`[setup] baseUrl=${baseUrl}`);

  // 3. Write driver test inside the project tree so bun's node_modules
  //    resolution finds `react`/`react-test-renderer`. A workDir-relative
  //    file path can't resolve up to the project's node_modules.
  // Use a `.driver.ts` suffix (not `.test.ts`) so a stale file left by a
  // crashed run isn't accidentally picked up by `bun test`'s glob discovery
  // when CI runs the regular suite. The script invokes `bun test <path>`
  // explicitly below, which works for any extension.
  const driverPath = join(
    PROJECT_ROOT,
    "tests",
    "e2e",
    `.confirm-and-mutate.driver.${process.pid}.ts`,
  );
  writeFileSync(driverPath, makeDriverTest(PROJECT_ROOT));
  driverPathToCleanup = driverPath;

  const serverLogFile = join(workDir, "server.log");

  // 4. Create tmux session (server pane)
  spawnSync(
    "tmux",
    [
      "-L",
      SOCKET,
      "new-session",
      "-d",
      "-s",
      SESSION,
      "-x",
      "220",
      "-y",
      "50",
      "sh",
      "-c",
      `${[
        `GROVE_DIR=${groveDir}`,
        `PORT=${SERVER_PORT}`,
        `bun run ${join(PROJECT_ROOT, "src/server/serve.ts")} 2>&1 | tee ${serverLogFile}`,
      ].join(" ")}; cat`,
    ],
    { stdio: "inherit" },
  );
  console.log(`[tmux] server pane started. Attach: tmux -L ${SOCKET} attach -t ${SESSION}`);

  if (ATTACH) {
    console.log(`\nAttach in another terminal:\n  tmux -L ${SOCKET} attach -t ${SESSION}\n`);
    await sleep(BUDGET_MS);
    return;
  }

  // 5. Wait for server to be listening
  await waitForPane((p) => /listening/.test(p), "server-ready", 30000);
  console.log("[phase 1] server listening");

  // 6. Split pane — driver pane (pane 1)
  spawnSync(
    "tmux",
    [
      "-L",
      SOCKET,
      "split-window",
      "-t",
      SESSION,
      "-h",
      "sh",
      "-c",
      // env vars must precede the final command, not the `cd`. Using `cd`
      // first, then `env` so the values reach `bun test`. The project's
      // bunfig coverage threshold (lines=0.8) makes `bun test` exit
      // non-zero on a passing test if the driver file's coverage is low —
      // the outer driver scrapes for `[smoke] OK` and ignores the exit
      // code precisely so this doesn't false-fail the smoke.
      `cd ${PROJECT_ROOT} && env GROVE_BASE_URL=${baseUrl} GROVE_TOKEN=${token} bun test ${driverPath}; echo "[driver-exit] code=$?"; cat`,
    ],
    { stdio: "inherit" },
  );
  console.log("[tmux] driver pane started");

  // Helper: capture driver pane (pane 1)
  const driverTarget = `${SESSION}.1`;

  // 7. Wait for the driver to print the smoke result.
  const finalPane = await waitForPane(
    (p) =>
      /\[smoke\] OK/.test(p) ||
      /\[FAIL/.test(p) ||
      /\[driver-exit\] code=/.test(p) ||
      /\b1 fail\b/.test(p),
    "driver-finished",
    60000,
    driverTarget,
  );

  // The driver explicitly prints `[smoke] OK` only when the test passes
  // AND the server-side archive verification succeeds. We treat that
  // marker as the source of truth — `bun test` may exit non-zero for
  // benign reasons (e.g., the project's coverage threshold from
  // bunfig.toml fails because the driver file's coverage is low), but
  // the operator-flow assertion has still passed. Order matters: smoke
  // marker first (success short-circuit), failure markers second.
  if (/\[smoke\] OK/.test(finalPane)) {
    console.log("[smoke] OK — confirm-and-mutate modal flow round-tripped through grove-server.");
    return;
  }

  if (
    /\[FAIL/.test(finalPane) ||
    /\b1 fail\b/.test(finalPane) ||
    /\[driver-exit\] code=[^0]/.test(finalPane)
  ) {
    console.error("\n──── driver pane (failure) ────");
    console.error(finalPane);
    console.error("──── server log tail ────");
    try {
      console.error(execSync(`tail -50 ${serverLogFile}`, { encoding: "utf-8" }));
    } catch {
      /* no log */
    }
    throw new Error("driver reported failure");
  }

  // No smoke marker, no failure marker — the driver hasn't completed yet.
  console.error("\n──── driver pane (no smoke marker) ────");
  console.error(finalPane);
  throw new Error("driver did not print [smoke] OK");
}

main()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch((err) => {
    console.error("[FAIL]", err);
    console.error("\n──── driver pane (error) ────");
    try {
      console.error(capturePane(`${SESSION}.1`));
    } catch {
      /* tmux already dead */
    }
    console.error("──── server pane (error) ────");
    try {
      console.error(capturePane(SESSION));
    } catch {
      /* tmux already dead */
    }
    cleanup();
    process.exit(1);
  });
