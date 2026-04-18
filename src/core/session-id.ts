/**
 * Canonical contract for grove agent session IDs.
 *
 * Every {@link AgentRuntime} implementation MUST construct session IDs via
 * {@link buildSessionId} and parse them via {@link parseSessionId}. This is
 * the single source of truth for the on-disk / on-tmux / on-acpx name shape:
 *
 *     grove-<role>-<counter>--<base36-timestamp>
 *
 * - `role` is the orchestration role passed to `spawn()` (may contain hyphens).
 * - `counter` is a monotonically increasing per-runtime integer used to
 *   distinguish sessions spawned in the same millisecond.
 * - `<base36-timestamp>` is `Date.now().toString(36)` and provides
 *   cross-process / cross-restart uniqueness so that `listSessions()` can
 *   safely rediscover sessions that outlive the runtime instance.
 *
 * The `--` (double dash) between counter and timestamp is intentional: it
 * disambiguates canonical IDs from the TUI's `grove-${agentId}` tmux session
 * names (single dashes) and from legacy pre-#210 IDs (`grove-<role>-<counter>`,
 * also single dashes), so a name like `grove-worker-1-mo3i3zh6` (TUI agent
 * with role `worker-1`) is never misparsed as canonical role `worker`.
 *
 * Consumers should treat the full ID as opaque and use {@link parseSessionId}
 * to recover `role`/`counter` rather than open-coding their own regex.
 */

export const SESSION_ID_PREFIX = "grove-";
const CANONICAL_SEPARATOR = "--";

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
  return `${SESSION_ID_PREFIX}${role}-${counter}${CANONICAL_SEPARATOR}${Date.now().toString(36)}`;
}

/**
 * Parse a grove session ID.
 *
 * Accepts both the canonical shape (`grove-<role>-<counter>--<base36>`)
 * emitted by {@link buildSessionId} and the legacy pre-#210 shape
 * (`grove-<role>-<counter>`). Returns `null` for anything else (notably the
 * TUI's `grove-${agentId}` tmux convention) so callers can safely filter
 * non-runtime sessions out of discovery.
 */
export function parseSessionId(name: string): ParsedSessionId | null {
  if (!name.startsWith(SESSION_ID_PREFIX)) return null;
  const body = name.slice(SESSION_ID_PREFIX.length);
  // Canonical: <role>-<counter>--<base36-suffix>. The double-dash separator
  // is what makes parsing unambiguous against single-dash conventions.
  const canonical = body.match(/^(.+)-(\d+)--([a-z0-9]+)$/);
  if (canonical) {
    const [, role, counterStr, suffix] = canonical;
    if (role && counterStr && suffix) {
      const counter = Number.parseInt(counterStr, 10);
      if (Number.isFinite(counter)) return { role, counter, suffix };
    }
  }
  // Legacy fallback: <role>-<counter> (no suffix). Only matches when there
  // is no `--` in the body so we don't falsely accept canonical-shaped names.
  if (body.includes(CANONICAL_SEPARATOR)) return null;
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

/**
 * Parse a session ID known to originate from acpx (e.g. the output of
 * `acpx sessions list` or `AcpxRuntime.discoverSessions()`).
 *
 * Extends {@link parseSessionId} with a transitional branch for the
 * pre-double-dash acpx shape `grove-<role>-<counter>-<base36>` so an
 * upgrade doesn't strand already-running agents that were created on the
 * older contract. Do NOT use this on tmux pane lookups — single-dash names
 * there can also be TUI sessions (`grove-${agentId}`) whose `agentId`
 * happens to look like `<role>-<counter>-<suffix>`, leading to misparse.
 */
export function parseAcpxSessionId(name: string): ParsedSessionId | null {
  const standard = parseSessionId(name);
  if (standard) return standard;
  if (!name.startsWith(SESSION_ID_PREFIX)) return null;
  const body = name.slice(SESSION_ID_PREFIX.length);
  if (body.includes(CANONICAL_SEPARATOR)) return null;
  // Prior-PR acpx shape: <role>-<counter>-<base36-suffix>, all single dashes.
  const priorAcpx = body.match(/^(.+)-(\d+)-([a-z0-9]+)$/);
  if (priorAcpx) {
    const [, role, counterStr, suffix] = priorAcpx;
    if (role && counterStr && suffix) {
      const counter = Number.parseInt(counterStr, 10);
      if (Number.isFinite(counter)) return { role, counter, suffix };
    }
  }
  return null;
}
