/**
 * Local hook runner — executes shell commands via child_process.exec.
 *
 * GROVE.md is a trusted, repo-owned file (same trust model as GitHub Actions
 * or .husky hooks). Commands run in a shell with:
 * - cwd set to the workspace directory
 * - configurable timeout (default 300s)
 * - maxBuffer limit (default 10MB) to prevent OOM from verbose output
 * - inherited PATH but minimal env to avoid leaking sensitive variables
 */

import { exec } from "node:child_process";

import type { HookEntry, HookResult, HookRunner } from "../core/hooks.js";
import { hookCommand, hookTimeout } from "../core/hooks.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for hook execution: 5 minutes. */
const DEFAULT_TIMEOUT_MS = 300_000;

/** Default max output buffer: 10 MB. */
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Options for configuring the local hook runner. */
export interface LocalHookRunnerOptions {
  /** Default timeout in milliseconds (overridden by per-hook timeout). */
  readonly defaultTimeoutMs?: number | undefined;
  /** Maximum stdout/stderr buffer size in bytes. */
  readonly maxBuffer?: number | undefined;
}

/**
 * Local hook runner using child_process.exec.
 *
 * Commands execute in a shell (sh on Unix, cmd on Windows) with the
 * workspace as the working directory. The environment is restricted
 * to PATH and HOME to minimize leakage of sensitive variables.
 */
export class LocalHookRunner implements HookRunner {
  private readonly defaultTimeoutMs: number;
  private readonly maxBuffer: number;

  constructor(options?: LocalHookRunnerOptions) {
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBuffer = options?.maxBuffer ?? DEFAULT_MAX_BUFFER;
  }

  async run(entry: HookEntry, cwd: string): Promise<HookResult> {
    const command = hookCommand(entry);
    const timeout = hookTimeout(entry, this.defaultTimeoutMs);
    const startTime = Date.now();

    return new Promise<HookResult>((resolve) => {
      exec(
        command,
        {
          cwd,
          timeout,
          maxBuffer: this.maxBuffer,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            // Pass TERM for proper output formatting in hooks
            TERM: process.env.TERM ?? "dumb",
          },
        },
        (error, stdout, stderr) => {
          const durationMs = Date.now() - startTime;

          if (error !== null) {
            resolve({
              success: false,
              exitCode: error.code ?? null,
              stdout: typeof stdout === "string" ? stdout : "",
              stderr: typeof stderr === "string" ? stderr : error.message,
              command,
              durationMs,
            });
            return;
          }

          resolve({
            success: true,
            exitCode: 0,
            stdout: typeof stdout === "string" ? stdout : "",
            stderr: typeof stderr === "string" ? stderr : "",
            command,
            durationMs,
          });
        },
      );
    });
  }
}
