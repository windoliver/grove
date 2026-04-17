/**
 * Typed ACP message streams. See
 * docs/superpowers/specs/2026-04-16-acp-typed-message-streams-design.md.
 */

export type Message =
  | { kind: "text"; turnId: string; text: string; chunk: boolean }
  | { kind: "thinking"; turnId: string; text: string; chunk: boolean }
  | { kind: "tool_call"; turnId: string; toolCall: ToolCall }
  | { kind: "permission_request"; turnId: string; request: PermissionRequest }
  | { kind: "token_usage"; turnId: string; usage: TokenUsage }
  | { kind: "raw"; turnId: string; acpMethod: string; params: unknown };

export type ToolCall = {
  id: string;
  name: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  input: unknown;
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
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
};

export type Result = {
  turnId: string;
  stopReason: "end_turn" | "max_tokens" | "cancelled" | "error";
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
