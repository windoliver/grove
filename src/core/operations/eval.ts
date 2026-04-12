/**
 * Eval operation.
 *
 * evalOperation — Run the contract's eval harness against a target CID and
 * return structured metric scores.
 *
 * The operation spawns the evalCommand as a subprocess (via `sh -c`),
 * streams stdout/stderr line-by-line looking for GROVE_SCORE lines, and
 * returns the parsed scores along with exit metadata.
 *
 * Score line format (stdout or stderr):
 *   GROVE_SCORE <metric_name>=<numeric_value>
 *
 * Example:
 *   GROVE_SCORE val_bpb=0.92
 *   GROVE_SCORE peak_vram_gb=14.3
 *
 * The target CID is passed to the subprocess via the GROVE_TARGET_CID
 * environment variable so eval scripts can locate the artifact.
 *
 * Output is streamed and capped at MAX_OUTPUT_BYTES (16 MB). The last 4 KB
 * of combined stdout+stderr is returned as rawTail for diagnostics.
 */

import { spawn } from "node:child_process";

import type { OperationDeps } from "./deps.js";
import type { OperationResult } from "./result.js";
import { err, OperationErrorCode, ok, validationErr } from "./result.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum combined stdout+stderr bytes buffered in memory. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024; // 16 MB

/** Tail of combined output returned for diagnostics (bytes). */
const TAIL_BYTES = 4096;

/** Default timeout when neither input nor contract specifies one (ms). */
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

/** Pattern for score lines emitted by the eval subprocess. */
const SCORE_LINE_RE =
  /^GROVE_SCORE\s+([a-z][a-z0-9_]*)=([-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)$/i;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single metric score returned by the eval harness. */
export interface EvalScore {
  readonly metric: string;
  readonly value: number;
}

/** Input for evalOperation. */
export interface EvalInput {
  /** CID of the contribution artifact to evaluate. Passed as GROVE_TARGET_CID env var. */
  readonly targetCid: string;
  /**
   * Shell command to execute as the eval harness.
   * Optional if the contract's evaluation config provides a default in a
   * future protocol version. Currently required — returns VALIDATION_ERROR
   * if omitted and no contract default is available.
   */
  readonly evalCommand?: string | undefined;
  /**
   * Timeout in milliseconds before the subprocess is killed.
   * Defaults to the contract's evaluation timeout if available, then
   * DEFAULT_TIMEOUT_MS (5 minutes).
   */
  readonly timeoutMs?: number | undefined;
}

/** Result of evalOperation on success. */
export interface EvalResult {
  /** Parsed metric scores from GROVE_SCORE lines in the subprocess output. */
  readonly scores: readonly EvalScore[];
  /** Exit code of the eval subprocess (0 = success). */
  readonly exitCode: number;
  /** True when the subprocess was killed due to timeout. */
  readonly timedOut: boolean;
  /** Last ~4 KB of combined stdout+stderr for diagnostics. */
  readonly rawTail: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Run the eval command as a subprocess, stream output, parse scores. */
async function runEvalSubprocess(
  command: string,
  targetCid: string,
  timeoutMs: number,
): Promise<{ scores: EvalScore[]; exitCode: number; timedOut: boolean; rawTail: string }> {
  return new Promise((resolve) => {
    const scores: EvalScore[] = [];
    let timedOut = false;
    let outputSize = 0;
    // Ring-buffer approach: keep the tail of output for diagnostics.
    let rawOutput = "";

    // detached: true puts the child in its own process group so we can
    // kill the entire tree (shell + any forked children) on timeout via
    // process.kill(-pid, signal) instead of just the sh wrapper.
    const child = spawn("sh", ["-c", command], {
      env: { ...process.env, GROVE_TARGET_CID: targetCid },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    /** Kill the full process group; fall back to the direct PID on error. */
    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already exited — ignore.
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      // Give the process group a moment to exit before SIGKILL.
      setTimeout(() => killGroup("SIGKILL"), 5000);
    }, timeoutMs);

    /** Append to the rolling output tail, respecting the cap. */
    const appendOutput = (chunk: string): void => {
      if (outputSize >= MAX_OUTPUT_BYTES) return;
      outputSize += chunk.length;
      rawOutput += chunk;
    };

    /** Parse a single line for a GROVE_SCORE entry. */
    const parseLine = (line: string): void => {
      const match = line.trim().match(SCORE_LINE_RE);
      if (match) {
        scores.push({ metric: match[1]?.toLowerCase() ?? "", value: parseFloat(match[2] ?? "0") });
      }
    };

    /** Stream a data chunk through a line buffer, calling parseLine per line. */
    const makeLineHandler = (): { handler: (chunk: Buffer) => void; flush: () => void } => {
      let buf = "";
      return {
        handler: (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          appendOutput(text);
          const combined = buf + text;
          const lines = combined.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) parseLine(line);
        },
        flush: () => {
          if (buf) {
            parseLine(buf);
            buf = "";
          }
        },
      };
    };

    const stdoutHandler = makeLineHandler();
    const stderrHandler = makeLineHandler();
    child.stdout?.on("data", stdoutHandler.handler);
    child.stderr?.on("data", stderrHandler.handler);

    child.on("close", (code) => {
      // Flush any partial line that didn't end with a newline (e.g. final GROVE_SCORE line).
      stdoutHandler.flush();
      stderrHandler.flush();
      clearTimeout(timer);
      const exitCode = code ?? (timedOut ? 124 : 1);
      // Return last TAIL_BYTES for diagnostics.
      const rawTail = rawOutput.length > TAIL_BYTES ? rawOutput.slice(-TAIL_BYTES) : rawOutput;
      resolve({ scores, exitCode, timedOut, rawTail });
    });
  });
}

// ---------------------------------------------------------------------------
// Operation
// ---------------------------------------------------------------------------

/** Run the eval harness against a target CID and return structured scores. */
export async function evalOperation(
  _deps: OperationDeps,
  input: EvalInput,
): Promise<OperationResult<EvalResult>> {
  const { targetCid, evalCommand, timeoutMs } = input;

  // Resolve the command to run.
  const command = evalCommand;
  if (!command) {
    return validationErr(
      "evalCommand is required: provide it as input or configure evaluation.eval_command in GROVE.md",
    );
  }

  // Validate targetCid is non-empty (format validation; existence check is out of scope
  // since eval may run before the contribution is written).
  if (!targetCid || targetCid.trim().length === 0) {
    return validationErr("targetCid must be a non-empty string");
  }

  // Resolve timeout: input > contract (future) > default.
  const resolvedTimeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const { scores, exitCode, timedOut, rawTail } = await runEvalSubprocess(
      command,
      targetCid.trim(),
      resolvedTimeout,
    );

    return ok({ scores, exitCode, timedOut, rawTail });
  } catch (error) {
    return err({
      code: OperationErrorCode.InternalError,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
