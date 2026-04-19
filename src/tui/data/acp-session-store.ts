/**
 * AcpSessionStore — in-memory per-session turn log keyed by turnId.
 *
 * See docs/superpowers/specs/2026-04-19-tui-typed-acp-consumer-design.md.
 */

import type { Message, Result } from "../../acp/types.js";

export interface TurnRecord {
  readonly turnId: string;
  readonly sessionId: string;
  readonly messages: Message[];
  readonly startedAt: number;
  closedAt?: number;
  stopReason?: Result["stopReason"];
  error?: Result["error"];
}

export interface SessionRecord {
  readonly sessionId: string;
  readonly registeredAt: number;
  readonly turns: Map<string, TurnRecord>;
  latestTurnId?: string;
}

export type AcpSinkEvent =
  | { kind: "message"; sessionId: string; turnId: string; message: Message }
  | { kind: "result"; sessionId: string; turnId: string; result: Result };
