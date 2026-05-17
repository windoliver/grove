/**
 * LogViewport — pure render component for a single agent's log tail.
 *
 * Subscribes to an AgentLogBuffer and renders a viewport slice with optional
 * substring filter, pause-freeze (frozen snapshot taken at the pause edge),
 * and autoscroll (scrollOffset === 0 means "stick to tail").
 *
 * Owns no keyboard input. State (paused, filter, scrollOffset) is supplied by
 * the parent — typically <LogView> or <TracePane>.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AgentLogBuffer, LogLine } from "../data/agent-log-buffer.js";
import { theme } from "../theme.js";

export interface LogViewportProps {
  readonly buffer: AgentLogBuffer;
  readonly paused: boolean;
  readonly filter: string;
  readonly scrollOffset: number;
  readonly viewportLines?: number;
  readonly title?: string;
}

const DEFAULT_VIEWPORT_LINES = 30;

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

export const LogViewport: React.NamedExoticComponent<LogViewportProps> = React.memo(
  function LogViewport({
    buffer,
    paused,
    filter,
    scrollOffset,
    viewportLines = DEFAULT_VIEWPORT_LINES,
    title,
  }: LogViewportProps): React.ReactNode {
    const [, setTick] = useState(0);
    useEffect(() => {
      const listener = (): void => setTick((t) => t + 1);
      buffer.subscribe(listener);
      return () => buffer.unsubscribe(listener);
    }, [buffer]);

    const frozenRef = useRef<readonly LogLine[] | null>(null);
    useEffect(() => {
      if (paused) {
        frozenRef.current = buffer.toArray();
      } else {
        frozenRef.current = null;
      }
    }, [paused, buffer]);

    const allLines: readonly LogLine[] = paused
      ? (frozenRef.current ?? buffer.toArray())
      : buffer.slice(0, buffer.size);

    const visible = useMemo<readonly LogLine[]>(() => {
      if (!filter) return allLines;
      return allLines.filter((l) => l.line.includes(filter));
    }, [allLines, filter]);

    const total = visible.length;
    const end = Math.max(0, total - scrollOffset);
    const start = Math.max(0, end - viewportLines);
    const displayLines = visible.slice(start, end);

    const isAutoScroll = scrollOffset === 0;
    const matchCountChip = filter ? `${visible.length}/${allLines.length}` : "";

    return (
      <box flexDirection="column" flexGrow={1}>
        <box flexDirection="row" paddingX={1}>
          <text color={theme.focus} bold>
            {title ?? `session: ${buffer.sessionId}`}
          </text>
          <text color={theme.secondary}>
            {` | ${allLines.length} lines | auto: ${isAutoScroll ? "ON" : `OFF (${scrollOffset}↑)`}`}
          </text>
          {filter && <text color={theme.warning}>{` | /${filter} (${matchCountChip})`}</text>}
          {paused && (
            <text color={theme.warning} bold>
              {" | ❚❚ PAUSED"}
            </text>
          )}
        </box>
        {displayLines.length === 0 ? (
          <box paddingX={1}>
            <text color={theme.secondary}>
              {filter ? "(no matching lines)" : "(no output yet)"}
            </text>
          </box>
        ) : (
          <box flexDirection="column" paddingX={1}>
            {displayLines.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: log lines have no stable identity
              <box key={i} flexDirection="row">
                <text color={theme.disabled}>{formatTimestamp(line.ts)} </text>
                <text opacity={line.historical ? 0.5 : 1}>{line.line}</text>
              </box>
            ))}
          </box>
        )}
      </box>
    );
  },
);
