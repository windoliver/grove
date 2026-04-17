/**
 * Typed ACP message streams. See
 * docs/superpowers/specs/2026-04-16-acp-typed-message-streams-design.md.
 */

export type Message =
  | { kind: "text"; turnId: string; text: string; chunk: boolean }
  | { kind: "thinking"; turnId: string; text: string; chunk: boolean }
  | { kind: "tool_call"; turnId: string; toolCall: ToolCallEvent }
  | { kind: "permission_request"; turnId: string; request: PermissionRequest }
  | { kind: "token_usage"; turnId: string; usage: TokenUsage }
  | { kind: "raw"; turnId: string; acpMethod: string; params: unknown };

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/**
 * Fully-populated tool call record. Produced by the compactor after folding
 * a sequence of `ToolCallEvent`s keyed by `id`.
 */
export type ToolCall = {
  id: string;
  name: string;
  status: ToolCallStatus;
  input: unknown;
  output?: unknown;
  diff?: string;
  error?: string;
};

/**
 * Partial/delta frame for a tool call. ACP emits one `tool_call` (initial) plus
 * N `tool_call_update` frames, each of which may omit fields that haven't
 * changed. The parser preserves that fidelity; the compactor folds the stream.
 */
export type ToolCallEvent = {
  id: string;
  name?: string;
  status?: ToolCallStatus;
  input?: unknown;
  output?: unknown;
  diff?: string;
  error?: string;
};

export type PermissionRequest = {
  id: string;
  tool: string;
  input: unknown;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  totalTokens?: number;
  cost?: { amount: number; currency: string };
};

/**
 * Terminal reason for a turn. The four canonical values are exposed as literals
 * so IDE completion still works. Unknown string values from future providers or
 * ACP spec updates are accepted as-is via the `(string & {})` escape — a result
 * frame with an unfamiliar stopReason is still a terminal result, not a parse
 * error.
 */
export type StopReason = "end_turn" | "max_tokens" | "cancelled" | "error" | (string & {});

export type Result = {
  turnId: string;
  stopReason: StopReason;
  /** Canonical per-turn token accounting, populated from the final ACP result frame when present. */
  usage?: TokenUsage;
  error?: { code: string; message: string };
};

export type AcpxTurn = {
  sessionId: string;
  turnId: string;
  messages: AsyncIterable<Message>;
  result: Promise<Result>;
  cancel(): Promise<void>;
  close(): Promise<void>;
};
