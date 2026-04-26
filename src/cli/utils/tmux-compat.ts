/**
 * Tmux compatibility shims for the grove TUI.
 *
 * OpenTUI sends Ptmux passthrough sequences (terminal capability queries)
 * during init. When tmux has `allow-passthrough off` (the default), those
 * sequences get dropped and the TUI hangs waiting for responses. We detect
 * we're running inside tmux via the TMUX env var and enable passthrough
 * on the current server.
 */

import { spawnSync } from "node:child_process";

export interface EnsureTmuxPassthroughOpts {
  readonly env?: NodeJS.ProcessEnv;
}

export type EnsureTmuxPassthroughResult =
  | { readonly applied: false; readonly reason: "not-in-tmux" }
  | { readonly applied: false; readonly reason: "tmux-failed"; readonly stderr: string }
  | { readonly applied: true };

export function ensureTmuxPassthrough(
  opts: EnsureTmuxPassthroughOpts = {},
): EnsureTmuxPassthroughResult {
  const env = opts.env ?? process.env;
  if (!env.TMUX) return { applied: false, reason: "not-in-tmux" };

  const result = spawnSync("tmux", ["set-option", "-g", "allow-passthrough", "on"], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (result.error || result.status !== 0) {
    return {
      applied: false,
      reason: "tmux-failed",
      stderr: (result.stderr ?? "").trim(),
    };
  }
  return { applied: true };
}
