/**
 * Persist Nexus connection info at ~/.grove/connection.json.
 *
 * User-level (survives before .grove/ exists in a project).
 * Atomic write (tmp + rename). Best-effort reads.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistedConnection {
  readonly nexusUrl: string;
  readonly apiKey?: string | undefined;
  readonly lastConnectedAt: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function groveHome(): string {
  const home = process.env.HOME ?? "/tmp";
  return join(home, ".grove");
}

function connectionPath(): string {
  return join(groveHome(), "connection.json");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Load previously persisted Nexus connection. Returns undefined on any failure. */
export function loadPersistedConnection(): PersistedConnection | undefined {
  try {
    const raw = readFileSync(connectionPath(), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.nexusUrl !== "string" || !parsed.nexusUrl) return undefined;
    return {
      nexusUrl: parsed.nexusUrl,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : undefined,
      lastConnectedAt: typeof parsed.lastConnectedAt === "string" ? parsed.lastConnectedAt : new Date().toISOString(),
    };
  } catch {
    return undefined;
  }
}

/** Atomically persist a Nexus connection. */
export function savePersistedConnection(conn: PersistedConnection): void {
  const dir = groveHome();
  mkdirSync(dir, { recursive: true });

  const target = connectionPath();
  const tmp = `${target}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(conn, null, 2) + "\n", "utf-8");
    renameSync(tmp, target);
  } catch {
    // Best effort — clean up tmp if rename failed
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/** Remove persisted connection. */
export function clearPersistedConnection(): void {
  try {
    unlinkSync(connectionPath());
  } catch {
    // Already absent or not writable — fine
  }
}
