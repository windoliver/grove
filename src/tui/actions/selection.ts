/**
 * Pure resolver for "which contribution is the operator acting on" in the
 * command palette. Kept separate from app.tsx so the focused-panel contract is
 * unit-testable.
 *
 * Contract (strict — no cross-panel fallback):
 *   - Frontier focused → the highlighted Frontier row (its own per-slice
 *     cursor→cid list). A cursor miss (empty/loading/stale slice, out of range)
 *     yields `undefined` so contribution actions DISAPPEAR rather than acting on
 *     an unrelated contribution.
 *   - Detail focused → the open detail's cid (`detailCid`).
 *   - Any other panel → `undefined` (no contribution is "selected" there;
 *     notably Activity/Terminal/DAG do not feed a reliable cursor→cid list).
 *
 * The result drives both built-in contribution actions AND the cid handed to
 * plugin actions, so non-contribution panels must produce `undefined`.
 */

import { Panel } from "../hooks/use-panel-focus.js";

export interface SelectionInput {
  readonly focusedPanel: Panel;
  readonly cursor: number;
  readonly frontierEntries: ReadonlyArray<{ readonly cid: string }>;
  readonly detailCid: string | undefined;
}

export function resolveSelectedCid(input: SelectionInput): string | undefined {
  if (input.focusedPanel === Panel.Frontier) {
    return input.frontierEntries[input.cursor]?.cid;
  }
  if (input.focusedPanel === Panel.Detail) {
    return input.detailCid;
  }
  return undefined;
}
