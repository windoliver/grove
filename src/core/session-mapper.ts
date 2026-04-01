/**
 * Maps core Session to TUI SessionRecord.
 *
 * Session (core) is the canonical type with config. SessionRecord (TUI/API)
 * is a read-only projection without the config blob, used for list views
 * and lightweight API responses.
 */

import type { GroveContract } from "./contract.js";
import type { Session } from "./session-manager.js";

/** Lightweight session record for list views (no config blob). */
export interface SessionRecordView {
  readonly sessionId: string;
  readonly goal?: string | undefined;
  readonly presetName?: string | undefined;
  readonly status: "active" | "archived";
  readonly startedAt: string;
  readonly endedAt?: string | undefined;
  readonly contributionCount: number;
  readonly config?: GroveContract | undefined;
}

/**
 * Project a core Session into a TUI-compatible SessionRecord.
 *
 * Maps field names (id → sessionId, createdAt → startedAt, etc.)
 * and translates the 4-state core status into the 2-state TUI status.
 */
export function toSessionRecord(session: Session, contributionCount = 0): SessionRecordView {
  return {
    sessionId: session.id,
    goal: session.goal,
    presetName: session.presetName,
    status: session.status === "pending" || session.status === "running" ? "active" : "archived",
    startedAt: session.createdAt,
    endedAt: session.completedAt,
    contributionCount,
  };
}
