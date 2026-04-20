/**
 * SessionPanel — native renderer for the typed ACP Message union.
 *
 * Subscribes to an AcpSessionStore for a given sessionId and renders the
 * most recent turn's messages. Status badge reflects the terminal
 * stopReason. Older turns are reachable via scrollback (j/k) — the data
 * model keeps them around; this initial version renders only the latest
 * turn's content to keep the first cut small.
 */

import type React from "react";
import { useEffect, useState } from "react";
import type { Message, Result } from "../../acp/types.js";
import type { AcpSessionStore, TurnRecord } from "../data/acp-session-store.js";
import { theme } from "../theme.js";

export type PanelLineKind = "text" | "thinking" | "tool" | "perm" | "raw";

export interface PanelLine {
  readonly kind: PanelLineKind;
  readonly text: string;
}

/** Pure data derivation, exported for unit tests. */
export function deriveSessionPanelLines(turn: TurnRecord): PanelLine[] {
  const out: PanelLine[] = [];
  let textBuf = "";

  const flushText = (): void => {
    if (textBuf.length > 0) {
      out.push({ kind: "text", text: textBuf });
      textBuf = "";
    }
  };

  for (const message of turn.messages) {
    switch (message.kind) {
      case "text":
        textBuf += message.text;
        break;
      case "tool_call": {
        flushText();
        const name = message.toolCall.name ?? message.toolCall.id;
        const status = message.toolCall.status ?? "update";
        out.push({ kind: "tool", text: `[tool] ${name} · ${status}` });
        break;
      }
      case "permission_request":
        flushText();
        out.push({ kind: "perm", text: `⚑ permission requested: ${message.request.tool}` });
        break;
      case "thinking":
        flushText();
        out.push({ kind: "thinking", text: `(thinking) ${message.text}` });
        break;
      case "raw":
        flushText();
        out.push({ kind: "raw", text: `[raw: ${message.acpMethod}]` });
        break;
      case "token_usage":
        // rendered separately in the footer; not a body line
        break;
    }
  }

  flushText();
  return out;
}

export function statusBadge(stopReason: Result["stopReason"] | undefined): string {
  if (stopReason === undefined) return "● running";
  switch (stopReason) {
    case "end_turn":
      return "✓ end_turn";
    case "max_tokens":
      return "⊘ max_tokens";
    case "cancelled":
      return "⊘ cancelled";
    case "error":
      return "✗ error";
    default:
      // Defined-but-unknown stopReason (forward-compat per StopReason's
      // `(string & {})` escape) is still terminal — render as generic
      // closed state rather than "running".
      return `✓ ${stopReason}`;
  }
}

export interface SessionPanelProps {
  readonly store: AcpSessionStore;
  readonly sessionId: string;
}

export function SessionPanel({ store, sessionId }: SessionPanelProps): React.ReactNode {
  const [, setTick] = useState(0);
  useEffect(() => {
    return store.subscribe(sessionId, () => setTick((t) => t + 1));
  }, [store, sessionId]);

  const session = store.getSession(sessionId);
  const turn =
    session?.latestTurnId !== undefined ? session.turns.get(session.latestTurnId) : undefined;

  const lines = turn ? deriveSessionPanelLines(turn) : [];
  const usage = turn ? findTokenUsage(turn.messages) : undefined;

  return (
    <box flexDirection="column" borderStyle="round" borderColor={theme.focus} paddingX={1}>
      <box flexDirection="row">
        <text color={theme.focus} bold>
          session {sessionId.slice(0, 12)}
        </text>
        <text color={theme.secondary}>· turn {turn ? turn.turnId.slice(-8) : "—"} </text>
        <text color={badgeColor(turn?.stopReason)}>{statusBadge(turn?.stopReason)}</text>
        {turn?.error ? (
          <text color={theme.error}>
            {" "}
            {turn.error.code}: {turn.error.message}
          </text>
        ) : null}
      </box>

      {lines.length === 0 ? (
        <text color={theme.secondary}>(no messages yet)</text>
      ) : (
        lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: panel lines have no stable identity
          <text key={i} color={lineColor(line.kind)}>
            {line.text}
          </text>
        ))
      )}

      {usage ? (
        <text color={theme.secondary}>
          usage · in={usage.inputTokens} out={usage.outputTokens}
        </text>
      ) : null}
    </box>
  );
}

function findTokenUsage(
  messages: readonly Message[],
): { inputTokens: number; outputTokens: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.kind === "token_usage") return m.usage;
  }
  return undefined;
}

function lineColor(kind: PanelLineKind): string {
  switch (kind) {
    case "text":
      return theme.text;
    case "tool":
      return theme.focus;
    case "perm":
      return theme.warning;
    case "thinking":
      return theme.disabled;
    case "raw":
      return theme.secondary;
  }
}

function badgeColor(stopReason: Result["stopReason"] | undefined): string {
  if (stopReason === undefined) return theme.focus;
  if (stopReason === "end_turn") return theme.success;
  if (stopReason === "error") return theme.error;
  return theme.warning;
}
