/**
 * Hook configuration and execution protocol for GROVE.md lifecycle hooks.
 *
 * Hooks are shell commands defined in GROVE.md that run at specific
 * points in the workspace lifecycle:
 * - after_checkout: runs after artifacts are materialized
 * - before_contribute: validation before accepting a contribution
 * - after_contribute: cleanup after contribution is submitted
 *
 * Hook failure in `before_contribute` blocks the contribution.
 * GROVE.md is a trusted, repo-owned file (like GitHub Actions workflows).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** A hook entry: either a command string or an object with cmd and optional timeout. */
export type HookEntry = string | { readonly cmd: string; readonly timeout?: number | undefined };

/** Schema for a single hook — either a command string or an object with options. */
export const HookEntrySchema: z.ZodType<HookEntry> = z.union([
  z.string().min(1),
  z.object({
    cmd: z.string().min(1),
    timeout: z.number().int().positive().optional(),
  }),
]);

/** Hooks configuration from GROVE.md. */
export interface HooksConfig {
  readonly after_checkout?: HookEntry | undefined;
  readonly before_contribute?: HookEntry | undefined;
  readonly after_contribute?: HookEntry | undefined;
}

/** Schema for the hooks section of GROVE.md. */
export const HooksConfigSchema: z.ZodType<HooksConfig> = z
  .object({
    after_checkout: HookEntrySchema.optional(),
    before_contribute: HookEntrySchema.optional(),
    after_contribute: HookEntrySchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the command string from a hook entry. */
export function hookCommand(entry: HookEntry): string {
  return typeof entry === "string" ? entry : entry.cmd;
}

/** Extract the timeout from a hook entry, or return the default. */
export function hookTimeout(entry: HookEntry, defaultMs: number): number {
  if (typeof entry === "string") return defaultMs;
  return entry.timeout ?? defaultMs;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Result of executing a hook. */
export interface HookResult {
  /** Whether the hook succeeded (exit code 0). */
  readonly success: boolean;
  /** Exit code (null if killed by signal). */
  readonly exitCode: number | null;
  /** Standard output. */
  readonly stdout: string;
  /** Standard error. */
  readonly stderr: string;
  /** The command that was executed. */
  readonly command: string;
  /** Duration in milliseconds. */
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

/**
 * Hook runner protocol.
 *
 * Implementations execute shell commands in a workspace context
 * with timeout and output limits.
 */
export interface HookRunner {
  /**
   * Execute a hook command in the given working directory.
   *
   * @param entry - The hook entry (command string or object).
   * @param cwd - Working directory for the command.
   * @returns The result of the execution.
   */
  run(entry: HookEntry, cwd: string): Promise<HookResult>;
}
