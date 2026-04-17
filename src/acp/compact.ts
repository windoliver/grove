/**
 * Fold a live event log (Messages + Result) into a compacted turn snapshot.
 * Idempotent: running twice on the same input yields the same output.
 *
 * Key invariants:
 * - Tool-call events are merged field-by-field (undefined fields never clobber
 *   previously-known values); status is monotonic (completed/failed are terminal
 *   and won't be reverted by a later "pending"/"in_progress" update).
 * - Canonical usage comes from `result.usage` when present; the last seen
 *   advisory `token_usage` Message is used only as a fallback.
 */

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

/** Finalize a partial accumulator into a fully-populated ToolCall with sensible defaults. */
function finalizeToolCall(partial: ToolCallEvent): ToolCall {
  const finalized: ToolCall = {
    id: partial.id,
    name: partial.name ?? "",
    status: partial.status ?? "pending",
    input: partial.input ?? {},
  };
  if (partial.title !== undefined) finalized.title = partial.title;
  if (partial.output !== undefined) finalized.output = partial.output;
  if (partial.diff !== undefined) finalized.diff = partial.diff;
  if (partial.error !== undefined) finalized.error = partial.error;
  return finalized;
}

/** Merge an incoming event into the running partial record, preserving known data. */
function mergeToolCallEvent(existing: ToolCallEvent, incoming: ToolCallEvent): ToolCallEvent {
  const merged: ToolCallEvent = { ...existing };
  if (incoming.name !== undefined) merged.name = incoming.name;
  if (incoming.title !== undefined) merged.title = incoming.title;
  if (incoming.status !== undefined) {
    const existingRank = merged.status ? STATUS_RANK[merged.status] : -1;
    const incomingRank = STATUS_RANK[incoming.status];
    // Monotonic: don't regress from a terminal state back to pending/in_progress.
    if (incomingRank >= existingRank) {
      merged.status = incoming.status;
    }
  }
  if (incoming.input !== undefined) merged.input = incoming.input;
  if (incoming.output !== undefined) merged.output = incoming.output;
  if (incoming.diff !== undefined) merged.diff = incoming.diff;
  if (incoming.error !== undefined) merged.error = incoming.error;
  return merged;
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
          toolCallMap.set(m.toolCall.id, { ...m.toolCall });
          toolCallOrder.push(m.toolCall.id);
        } else {
          toolCallMap.set(m.toolCall.id, mergeToolCallEvent(existing, m.toolCall));
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
        // Parser demotes malformed frames to raw. Surface the ones that
        // represent real semantic activity (tool calls, permission prompts)
        // so audit/telemetry doesn't silently lose them from the snapshot.
        if (m.acpMethod === "tool_call" || m.acpMethod === "tool_call_update") {
          rawToolFrames.push({ acpMethod: m.acpMethod, params: m.params });
        } else if (m.acpMethod === "permission_request") {
          rawPermissionFrames.push({ acpMethod: m.acpMethod, params: m.params });
        } else if (m.acpMethod === "_overflow") {
          overflowed = true;
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
    overflowed,
    // Canonical usage only — do NOT fall back to advisory usage_update values.
    // See the TurnSnapshot.usage JSDoc for the rationale.
    usage: input.result.usage,
    advisoryUsage,
    stopReason: input.result.stopReason,
    error: input.result.error,
  };
}
