/**
 * Canonical contract for grove agent session IDs.
 *
 * Every {@link AgentRuntime} implementation MUST construct session IDs via
 * {@link buildSessionId} and parse them via {@link parseSessionId}. This is
 * the single source of truth for the on-disk / on-tmux / on-acpx name shape:
 *
 *     grove-<role>-<counter>-<base36-timestamp>
 *
 * - `role` is the orchestration role passed to `spawn()` (may contain hyphens).
 * - `counter` is a monotonically increasing per-runtime integer used to
 *   distinguish sessions spawned in the same millisecond.
 * - `<base36-timestamp>` is `Date.now().toString(36)` and provides
 *   cross-process / cross-restart uniqueness so that `listSessions()` can
 *   safely rediscover sessions that outlive the runtime instance.
 *
 * Consumers should treat the full ID as opaque and use {@link parseSessionId}
 * to recover `role`/`counter` rather than open-coding their own regex.
 */

export const SESSION_ID_PREFIX = "grove-";

export interface ParsedSessionId {
  readonly role: string;
  readonly counter: number;
  readonly suffix: string;
}

export function buildSessionId(role: string, counter: number): string {
  return `${SESSION_ID_PREFIX}${role}-${counter}-${Date.now().toString(36)}`;
}

/**
 * Parse a grove session ID emitted by {@link buildSessionId}.
 *
 * Returns `null` for any name that doesn't follow the canonical shape, which
 * lets callers safely filter foreign tmux/acpx sessions out of discovery.
 */
export function parseSessionId(name: string): ParsedSessionId | null {
  if (!name.startsWith(SESSION_ID_PREFIX)) return null;
  const body = name.slice(SESSION_ID_PREFIX.length);
  // Anchor on the last two `-`-separated segments: counter + suffix.
  // Everything before is the role (which may itself contain hyphens).
  const match = body.match(/^(.+)-(\d+)-([a-z0-9]+)$/);
  if (!match) return null;
  const [, role, counterStr, suffix] = match;
  if (!role || !counterStr || !suffix) return null;
  const counter = Number.parseInt(counterStr, 10);
  if (!Number.isFinite(counter)) return null;
  return { role, counter, suffix };
}
