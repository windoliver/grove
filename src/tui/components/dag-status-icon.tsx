/**
 * <DagStatusIcon /> — single-character status glyph for xray DAG rows (#311).
 *
 * Presentational only. Color and glyph are determined entirely by the
 * status value; no internal state.
 */

import React from "react";
import { theme } from "../theme.js";
import type { DagNodeStatus } from "../views/derive-dag-status.js";

export interface DagStatusIconProps {
  readonly status: DagNodeStatus;
}

const GLYPH: Record<DagNodeStatus, string> = {
  running: "◐",
  done: "✓",
  failed: "✗",
  blocked: "⊘",
  "awaiting-review": "?",
  idle: "·",
};

const COLOR_KEY: Record<DagNodeStatus, keyof typeof theme> = {
  running: "statusRunning",
  done: "statusDone",
  failed: "statusFailed",
  blocked: "statusBlocked",
  "awaiting-review": "statusAwaitingReview",
  idle: "statusIdle",
};

export const DagStatusIcon: React.NamedExoticComponent<DagStatusIconProps> = React.memo(
  function DagStatusIcon({ status }: DagStatusIconProps): React.ReactNode {
    const color = theme[COLOR_KEY[status]];
    return <text color={typeof color === "string" ? color : undefined}>{GLYPH[status]}</text>;
  },
);
