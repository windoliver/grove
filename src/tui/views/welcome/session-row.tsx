/**
 * Session row renderer for the welcome fast-path.
 *
 * Focused row renders rich (two lines, bold, more metadata).
 * Unfocused rows render compact (one dim line).
 *
 * `computeSessionRowFields` is a pure helper used by both this component
 * and the test suite.
 */

import React from "react";
import type { SessionRecord } from "../../provider.js";
import { theme } from "../../theme.js";
import { formatRelativeTime } from "./relative-time.js";

const GOAL_MAX = 50;

/** Props for a single session row. */
export interface SessionRowProps {
  readonly session: SessionRecord;
  readonly focused: boolean;
  readonly now?: number;
}

/** Computed fields used for rendering — exported for testability. */
export interface SessionRowFields {
  readonly dot: "●" | "○";
  readonly rich: boolean;
  readonly primary: string;
  readonly secondary: string | undefined;
}

/** Compute the flattened strings for a session row. */
export function computeSessionRowFields(
  session: SessionRecord,
  opts: { focused: boolean; now: number },
): SessionRowFields {
  const dot: "●" | "○" = session.status === "active" ? "●" : "○";
  const goal = (session.goal ?? "untitled").slice(0, GOAL_MAX);
  const when = formatRelativeTime(session.createdAt, opts.now);
  const count = `${session.contributionCount}c`;

  if (opts.focused) {
    const primary = `${dot} "${goal}"  ${count} · ${when}`;
    const secondary = session.presetName ? session.presetName : undefined;
    return { dot, rich: true, primary, secondary };
  }

  return {
    dot,
    rich: false,
    primary: `${dot} "${goal}"  ${count} · ${when}`,
    secondary: undefined,
  };
}

/** Render a single session row. */
export const SessionRow: React.NamedExoticComponent<SessionRowProps> = React.memo(
  function SessionRow({ session, focused, now }: SessionRowProps): React.ReactNode {
    const fields = computeSessionRowFields(session, {
      focused,
      now: now ?? Date.now(),
    });
    const color = focused
      ? theme.focus
      : session.status === "active"
        ? theme.text
        : theme.secondary;
    return (
      <box
        flexDirection="column"
        backgroundColor={focused ? theme.selectedBg : undefined}
      >
        <text color={color} bold={focused}>
          {focused ? "> " : "  "}
          {fields.primary}
        </text>
        {fields.secondary ? (
          <text color={theme.secondary}>{`    ${fields.secondary}`}</text>
        ) : null}
      </box>
    );
  },
);
