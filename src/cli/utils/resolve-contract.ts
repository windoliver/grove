/**
 * Shared contract-resolution bootstrap for CLI write paths.
 *
 * Resolution precedence:
 *   1. session.config (frozen snapshot from #198) when GROVE_SESSION_ID is set
 *      and the session has a stored config — use it, skip GROVE.md entirely.
 *   2. Live GROVE.md — used when no session is set, or when the session exists
 *      but has no stored config (configless sessions are valid state:
 *      orchestrator calls createSession with config=undefined when GROVE.md is
 *      absent; legacy pre-#198 sessions also lack config).
 *   3. No enforcement — neither session config nor GROVE.md available.
 *
 * Fail-closed cases:
 *   - GROVE_SESSION_ID points at a session that does not exist (stale env var)
 *   - Session row has malformed / schema-invalid config_json
 *   - GROVE.md exists but is unreadable for a non-ENOENT reason (permission,
 *     I/O error) — the caller must see the failure rather than silently
 *     dropping to unenforced mode.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type GroveContract, parseGroveContract } from "../../core/contract.js";
import type { SqliteGoalSessionStore } from "../../local/sqlite-goal-session-store.js";

export interface ResolveContractInput {
  readonly goalSessionStore: SqliteGoalSessionStore;
  readonly groveRoot: string;
  readonly envSessionId?: string | undefined;
}

export async function resolveContract(
  input: ResolveContractInput,
): Promise<GroveContract | undefined> {
  const { goalSessionStore, groveRoot, envSessionId } = input;

  if (envSessionId) {
    const result = goalSessionStore.resolveSessionConfigSync(envSessionId);
    if (result.kind === "ok") {
      return result.config;
    }
    if (result.kind === "not-found") {
      throw new Error(
        `Session ${envSessionId} not found. GROVE_SESSION_ID points at a ` +
          `session that does not exist in this grove's session store.`,
      );
    }
    if (result.kind === "malformed") {
      throw new Error(
        `Session ${envSessionId} has malformed config_json: ${result.reason}. ` +
          `Refusing to proceed with unknown enforcement state.`,
      );
    }
    // kind === "configless": fall through to GROVE.md below
  }

  const grovemdPath = join(groveRoot, "GROVE.md");
  let grovemdContent: string | undefined;
  try {
    grovemdContent = await readFile(grovemdPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      throw err;
    }
    // GROVE.md does not exist — proceed without enforcement
    return undefined;
  }
  // parseGroveContract intentionally runs OUTSIDE the catch: YAML/schema
  // errors must propagate, not be swallowed as "no contract".
  return parseGroveContract(grovemdContent);
}
