/**
 * Fold a live event log (Messages + Result) into a compacted turn snapshot.
 * Idempotent: running twice on the same input yields the same output.
 *
 * Key invariants:
 * - Tool-call events are merged field-by-field (undefined fields never clobber
 *   previously-known values); status is monotonic (completed/failed are terminal
 *   and won't be reverted by a later "pending"/"in_progress" update).
 * - Canonical usage comes ONLY from `result.usage`; advisory `token_usage`
 *   frames are preserved separately as `advisoryUsage` and never promoted
 *   into canonical per-turn accounting.
 */

import { isDeepStrictEqual } from "node:util";
import type {
  Message,
  PermissionRequest,
  Result,
  StopReason,
  TokenUsage,
  ToolCall,
  ToolCallEvent,
  ToolCallStatus,
} from "./types.js";

export interface TurnSnapshot {
  turnId: string;
  assistantText: string;
  thinkingText: string;
  /**
   * Fully-identified tool calls (both name and input were observed for this id
   * across the event log). Safe to key audit/permission/UI off of `name`.
   */
  toolCalls: ToolCall[];
  /**
   * Tool-call ids that appeared in the stream but never accumulated enough
   * data to finalize (e.g. only `tool_call_update` frames were seen, with no
   * initial `tool_call` providing the canonical name or input). Surfaced as
   * raw partial events rather than folded into `toolCalls` with blank names
   * so schema drift and parser demotions (missing id, unknown status) stay
   * visible instead of being silently coerced into valid-looking records.
   */
  incompleteToolCalls: ToolCallEvent[];
  /**
   * Raw tool-call frames the parser demoted before they could be structured
   * (missing `toolCallId`, unknown status string, etc). Preserved here so
   * downstream audit/telemetry can see that tool activity occurred even
   * though the schema didn't match — without these, demoted frames would
   * disappear entirely from the compacted snapshot.
   */
  rawToolFrames: Array<{ acpMethod: string; params: unknown }>;
  /** Permission prompts the provider asked for during this turn. */
  permissionRequests: PermissionRequest[];
  /**
   * Raw permission_request frames the parser demoted before they could be
   * structured (missing id or tool). Preserved here so audit/telemetry still
   * sees that a permission prompt was asked — dropping them would let a
   * malformed prompt vanish from the snapshot entirely, which is exactly
   * the category of drift the permission pipeline must NOT hide.
   */
  rawPermissionFrames: Array<{ acpMethod: string; params: unknown }>;
  /**
   * Parser-internal anomaly frames (underscore-prefixed acpMethods such as
   * `_sessionMismatch`, `_parseError`, `_result`, `_unknown`) preserved from
   * the message stream. These are the parser's visible-evidence trail that
   * something went wrong mid-turn: a foreign-session frame was rejected,
   * NDJSON failed to parse, etc. Dropping them would let a contaminated or
   * corrupted turn compact into a clean-looking audit record with no trace
   * of the isolation/integrity alarm. `_overflow` is excluded because it
   * has its own `overflowed` boolean flag.
   */
  rawAnomalyFrames: Array<{ acpMethod: string; params: unknown }>;
  /**
   * Catch-all bucket for forward-compat raw frames that don't match any of
   * the other categories — e.g. future ACP `sessionUpdate` kinds the parser
   * doesn't understand yet, or unknown JSON-RPC methods. Preserved so a
   * schema-drifted turn doesn't silently lose frames when the live event
   * log is later pruned. Underscore-prefixed parser-internal methods
   * (anomalies) go to `rawAnomalyFrames`; tool/permission semantic raws
   * have their own dedicated buckets.
   */
  otherRawFrames: Array<{ acpMethod: string; params: unknown }>;
  /**
   * True when the message stream included a bounded-buffer `_overflow`
   * marker. Any consumer or snapshot-reader MUST treat a snapshot with
   * `overflowed:true` as a partial log — assistantText, toolCalls, and
   * incompleteToolCalls are not guaranteed complete.
   */
  overflowed: boolean;
  /**
   * Canonical per-turn token accounting, populated only from `result.usage`.
   * Stays undefined when the provider didn't emit canonical counts on the
   * final frame — do NOT fall back to advisory `usage_update` values here;
   * they are rolling-window meters, not per-turn totals, and confusing the
   * two silently corrupts billing/quota telemetry.
   */
  usage: TokenUsage | undefined;
  /**
   * Last advisory `usage_update` snapshot observed during the turn. These are
   * progress/meter values (context window usage, rolling cost) with different
   * provenance than canonical usage — consumers must treat them accordingly.
   */
  advisoryUsage: TokenUsage | undefined;
  stopReason: StopReason;
  error: Result["error"] | undefined;
}

const STATUS_RANK: Record<ToolCallStatus, number> = {
  pending: 0,
  in_progress: 1,
  completed: 2,
  failed: 2,
};

/**
 * Finalize a partial accumulator into a fully-populated ToolCall. The caller
 * must have verified that `partial.name` and `partial.input` are both set
 * (`compactTurn` gates this via the `name !== undefined && input !== undefined`
 * check). Incomplete partials go to `incompleteToolCalls` instead, so the
 * previous `?? ""` / `?? {}` defaults here were dead code that hid the
 * invariant.
 */
function finalizeToolCall(partial: ToolCallEvent): ToolCall {
  if (partial.name === undefined || partial.input === undefined) {
    throw new Error(`finalizeToolCall invariant: name/input required (id=${partial.id})`);
  }
  const finalized: ToolCall = {
    id: partial.id,
    name: partial.name,
    status: partial.status ?? "pending",
    input: partial.input,
  };
  if (partial.title !== undefined) finalized.title = partial.title;
  if (partial.output !== undefined) finalized.output = partial.output;
  if (partial.diff !== undefined) finalized.diff = partial.diff;
  if (partial.error !== undefined) finalized.error = partial.error;
  return finalized;
}

/**
 * Merge an incoming event into the running partial record, preserving known
 * data. Mutates `existing` in place — long turns can emit hundreds of updates
 * against a single tool call, and the old "clone existing on every merge"
 * pattern was O(M²) field copies. The map holds the only reference, and the
 * Message's toolCall object is never aliased into the map (compactTurn spreads
 * `{ ...m.toolCall }` on first insertion), so mutating the accumulator is
 * safe.
 */
function mergeToolCallEvent(existing: ToolCallEvent, incoming: ToolCallEvent): void {
  if (incoming.name !== undefined) existing.name = incoming.name;
  if (incoming.title !== undefined) existing.title = incoming.title;

  // Gate `status` and its payload (input/output/diff/error) together. Reordered
  // or regressive statuses (e.g. completed→failed duplicate, failed→completed
  // reorder, in_progress→pending) are rejected as a unit so they cannot
  // contaminate the accepted outcome. Same-status duplicates are allowed to
  // enrich payload fields, because providers may emit final output/error on a
  // later frame that repeats the already-seen terminal status.
  let payloadAccepted = true;
  let terminalStatusless = false;
  if (incoming.status !== undefined) {
    if (existing.status === undefined) {
      existing.status = incoming.status;
    } else {
      const existingRank = STATUS_RANK[existing.status];
      const incomingRank = STATUS_RANK[incoming.status];
      if (incomingRank > existingRank) {
        existing.status = incoming.status;
      } else if (incomingRank === existingRank && incoming.status === existing.status) {
        // Duplicate same-status frame: keep status and accept payload.
      } else {
        payloadAccepted = false;
      }
    }
  } else if (existing.status !== undefined && STATUS_RANK[existing.status] === 2) {
    terminalStatusless = true;
    // Existing call is terminal and the incoming frame carries no lifecycle
    // information of its own. Permit safe enrichment (fill missing fields)
    // and ignore per-field conflicts, preserving first-terminal values while
    // still accepting new diagnostics on other fields from the same frame.
  }
  if (payloadAccepted) {
    if (terminalStatusless) {
      // Terminal + no status: atomic enrichment-only path.
      // Accept the whole payload only when every provided field is compatible
      // with the existing terminal record (missing-or-equal). If any field
      // conflicts, reject the entire frame to avoid mixed terminal snapshots
      // such as {status:"completed", output:"ok", error:"stale"} from stale
      // duplicates.
      const compatible =
        (incoming.input === undefined ||
          existing.input === undefined ||
          isDeepStrictEqual(existing.input, incoming.input)) &&
        (incoming.output === undefined ||
          existing.output === undefined ||
          isDeepStrictEqual(existing.output, incoming.output)) &&
        (incoming.diff === undefined ||
          existing.diff === undefined ||
          isDeepStrictEqual(existing.diff, incoming.diff)) &&
        (incoming.error === undefined ||
          existing.error === undefined ||
          isDeepStrictEqual(existing.error, incoming.error));

      if (compatible) {
        if (incoming.input !== undefined && existing.input === undefined)
          existing.input = incoming.input;
        if (incoming.output !== undefined && existing.output === undefined)
          existing.output = incoming.output;
        if (incoming.diff !== undefined && existing.diff === undefined)
          existing.diff = incoming.diff;
        if (incoming.error !== undefined && existing.error === undefined)
          existing.error = incoming.error;
      }
    } else {
      if (incoming.input !== undefined) existing.input = incoming.input;
      if (incoming.output !== undefined) existing.output = incoming.output;
      if (incoming.diff !== undefined) existing.diff = incoming.diff;
      if (incoming.error !== undefined) existing.error = incoming.error;
    }
  }
}

export function compactTurn(input: {
  turnId: string;
  messages: readonly Message[];
  result: Result;
}): TurnSnapshot {
  let assistantText = "";
  let thinkingText = "";
  const toolCallMap = new Map<string, ToolCallEvent>();
  const toolCallOrder: string[] = [];
  const rawToolFrames: Array<{ acpMethod: string; params: unknown }> = [];
  const rawPermissionFrames: Array<{ acpMethod: string; params: unknown }> = [];
  const rawAnomalyFrames: Array<{ acpMethod: string; params: unknown }> = [];
  const otherRawFrames: Array<{ acpMethod: string; params: unknown }> = [];
  const permissionRequests: PermissionRequest[] = [];
  let advisoryUsage: TokenUsage | undefined;
  let overflowed = false;

  for (const m of input.messages) {
    switch (m.kind) {
      case "text":
        assistantText += m.text;
        break;
      case "thinking":
        thinkingText += m.text;
        break;
      case "tool_call": {
        const existing = toolCallMap.get(m.toolCall.id);
        if (existing === undefined) {
          // Spread so the stored accumulator is NOT an alias to the message's
          // toolCall object — later in-place merges would otherwise leak back
          // into the original Message sequence (which tests reuse).
          toolCallMap.set(m.toolCall.id, { ...m.toolCall });
          toolCallOrder.push(m.toolCall.id);
        } else {
          mergeToolCallEvent(existing, m.toolCall);
        }
        break;
      }
      case "permission_request":
        permissionRequests.push(m.request);
        break;
      case "token_usage":
        advisoryUsage = m.usage;
        break;
      case "raw":
        // Parser demotes malformed or anomalous frames to raw. Surface every
        // signal the snapshot consumer cares about — tool/permission
        // semantic activity, plus the parser's own anomaly trail (isolation
        // alarms like `_sessionMismatch`, parse errors, unknown methods).
        // Dropping anomaly frames would let a contaminated turn look clean.
        if (m.acpMethod === "tool_call" || m.acpMethod === "tool_call_update") {
          rawToolFrames.push({ acpMethod: m.acpMethod, params: m.params });
        } else if (m.acpMethod === "permission_request") {
          rawPermissionFrames.push({ acpMethod: m.acpMethod, params: m.params });
        } else if (m.acpMethod === "_overflow") {
          overflowed = true;
        } else if (m.acpMethod.startsWith("_")) {
          // Parser-internal anomaly bucket: _sessionMismatch, _parseError,
          // _result, _unknown, future additions. Kept out of rawToolFrames
          // so consumers can tell semantic-activity raws apart from alarms.
          rawAnomalyFrames.push({ acpMethod: m.acpMethod, params: m.params });
        } else {
          // Forward-compat catch-all: unknown sessionUpdate kinds, future
          // ACP additions, or JSON-RPC methods the parser doesn't recognize.
          // Keeping these around means schema drift survives compaction
          // instead of silently disappearing from the snapshot.
          otherRawFrames.push({ acpMethod: m.acpMethod, params: m.params });
        }
        break;
    }
  }

  const toolCalls: ToolCall[] = [];
  const incompleteToolCalls: ToolCallEvent[] = [];
  for (const id of toolCallOrder) {
    const partial = toolCallMap.get(id);
    if (!partial) throw new Error(`tool call ${id} missing from map`);
    // A tool call is only "complete" when we observed its canonical identity
    // (name) AND input. Orphan tool_call_update frames without a preceding
    // tool_call never reach that bar — don't fabricate blank defaults.
    if (partial.name !== undefined && partial.input !== undefined) {
      toolCalls.push(finalizeToolCall(partial));
    } else {
      incompleteToolCalls.push(partial);
    }
  }

  return {
    turnId: input.turnId,
    assistantText,
    thinkingText,
    toolCalls,
    incompleteToolCalls,
    rawToolFrames,
    permissionRequests,
    rawPermissionFrames,
    rawAnomalyFrames,
    otherRawFrames,
    overflowed,
    // Canonical usage only — do NOT fall back to advisory usage_update values.
    // See the TurnSnapshot.usage JSDoc for the rationale.
    usage: input.result.usage,
    advisoryUsage,
    stopReason: input.result.stopReason,
    error: input.result.error,
  };
}
