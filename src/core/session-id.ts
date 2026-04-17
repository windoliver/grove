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
  /**
   * Base36 timestamp suffix from {@link buildSessionId}. `null` when parsing
   * a legacy ID (`grove-<role>-<counter>`) emitted by the older tmux contract,
   * preserved here so post-upgrade rediscovery doesn't drop live sessions.
   */
  readonly suffix: string | null;
}

export function buildSessionId(role: string, counter: number): string {
  return `${SESSION_ID_PREFIX}${role}-${counter}-${Date.now().toString(36)}`;
}

/**
 * Parse a grove session ID.
 *
 * Accepts both the canonical shape (`grove-<role>-<counter>-<base36>`) emitted
 * by {@link buildSessionId} and the legacy pre-#210 shape
 * (`grove-<role>-<counter>`). Returns `null` for anything else so callers can
 * safely filter foreign tmux/acpx sessions out of discovery.
 */
export function parseSessionId(name: string): ParsedSessionId | null {
  if (!name.startsWith(SESSION_ID_PREFIX)) return null;
  const body = name.slice(SESSION_ID_PREFIX.length);
  // Try canonical first: <role>-<counter>-<base36-suffix>
  const canonical = body.match(/^(.+)-(\d+)-([a-z0-9]+)$/);
  if (canonical) {
    const [, role, counterStr, suffix] = canonical;
    if (role && counterStr && suffix) {
      const counter = Number.parseInt(counterStr, 10);
      if (Number.isFinite(counter)) return { role, counter, suffix };
    }
  }
  // Legacy fallback: <role>-<counter> (no suffix).
  const legacy = body.match(/^(.+)-(\d+)$/);
  if (legacy) {
    const [, role, counterStr] = legacy;
    if (role && counterStr) {
      const counter = Number.parseInt(counterStr, 10);
      if (Number.isFinite(counter)) return { role, counter, suffix: null };
    }
  }
  return null;
}
