/**
 * FileSessionStore — persists TUI agent spawn records to disk.
 *
 * Used by SpawnManager to survive TUI crashes and restarts.
 * Records are stored in `.grove/tui-sessions.json` and reconciled
 * on startup to reattach live tmux sessions or clean up dead ones.
 *
 * All operations are best-effort: corrupted or missing files
 * are treated as empty state rather than fatal errors.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** A spawn record suitable for on-disk persistence. */
export interface PersistedSpawnRecord {
  readonly spawnId: string;
  readonly claimId: string;
  readonly targetRef: string;
  readonly agentId: string;
  readonly workspacePath: string;
  readonly spawnedAt: string;
}

/** Interface for persisting spawn records across TUI restarts. */
export interface SessionStore {
  save(record: PersistedSpawnRecord): void;
  remove(spawnId: string): void;
  loadAll(): readonly PersistedSpawnRecord[];
}

/**
 * File-backed session store that persists to a JSON file.
 *
 * Uses atomic writes (write temp + rename) to avoid partial writes
 * on crash. All errors are absorbed — session persistence is best-effort.
 */
export class FileSessionStore implements SessionStore {
  private readonly filePath: string;

  constructor(groveDir: string) {
    this.filePath = join(groveDir, "tui-sessions.json");
  }

  save(record: PersistedSpawnRecord): void {
    try {
      const records = this.readFile();
      const existing = records.findIndex((r) => r.spawnId === record.spawnId);
      if (existing >= 0) {
        records[existing] = record;
      } else {
        records.push(record);
      }
      this.writeFile(records);
    } catch {
      // Best-effort: don't crash if persistence fails
    }
  }

  remove(spawnId: string): void {
    try {
      const records = this.readFile();
      const filtered = records.filter((r) => r.spawnId !== spawnId);
      this.writeFile(filtered);
    } catch {
      // Best-effort: don't crash if persistence fails
    }
  }

  loadAll(): readonly PersistedSpawnRecord[] {
    try {
      return this.readFile();
    } catch {
      return [];
    }
  }

  /** Read and parse the session file. Returns mutable array for internal use. */
  private readFile(): PersistedSpawnRecord[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Validate each record has the required shape
    return parsed.filter(
      (r: unknown): r is PersistedSpawnRecord =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as PersistedSpawnRecord).spawnId === "string" &&
        typeof (r as PersistedSpawnRecord).claimId === "string" &&
        typeof (r as PersistedSpawnRecord).targetRef === "string" &&
        typeof (r as PersistedSpawnRecord).agentId === "string" &&
        typeof (r as PersistedSpawnRecord).workspacePath === "string" &&
        typeof (r as PersistedSpawnRecord).spawnedAt === "string",
    );
  }

  /** Write records atomically: write to temp file, then rename. */
  private writeFile(records: readonly PersistedSpawnRecord[]): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(records, null, 2), "utf-8");
    renameSync(tmpPath, this.filePath);
  }
}
