/**
 * Pure key router for SupervisionScreen. Caller (the screen) reads
 * the returned SupervisionAction and dispatches it to the appropriate
 * handler. No React, no side effects.
 *
 * Precedence (top wins):
 *   1. cmdMode === "filter"        → filter-input characters / Escape
 *   2. modalOpen                   → modal keys (y/n/d/Escape)
 *   3. focusedAgentAwaiting        → per-card y/n
 *   4. drillOpen                   → Tab cycle / 1-2-3 tab jump / Escape close
 *   5. grid keys                   → hjkl, g/G, Enter, /, s, f, c, A, ...
 */

import type { DrillTab } from "./types.js";

export type SupervisionAction =
  | { kind: "accept-approval" }
  | { kind: "reject-approval" }
  | { kind: "toggle-approval-detail" }
  | { kind: "close-modal" }
  | { kind: "accept-focused-approval" }
  | { kind: "reject-focused-approval" }
  | { kind: "cursor-left" | "cursor-right" | "cursor-up" | "cursor-down" }
  | { kind: "cursor-top" | "cursor-bottom" }
  | { kind: "open-drill" | "close-drill" }
  | { kind: "open-next-approval" }
  | { kind: "enter-filter" }
  | { kind: "cycle-sort" }
  | { kind: "cycle-state-filter" }
  | { kind: "copy-agent-id" }
  | { kind: "cycle-drill-tab" }
  | { kind: "set-drill-tab"; tab: DrillTab }
  | { kind: "exit-cmd-mode" }
  | { kind: "cmd-mode-char"; char: string }
  | { kind: "cmd-mode-backspace" }
  | { kind: "back-to-main" };

export interface SupervisionContext {
  readonly modalOpen: boolean;
  readonly focusedAgentAwaiting: boolean;
  readonly drillOpen: boolean;
  readonly cmdMode: "idle" | "filter";
}

export function routeKey(key: string, ctx: SupervisionContext): SupervisionAction | undefined {
  // 1. cmd-mode (filter input) — capture characters before grid keys steal them
  if (ctx.cmdMode === "filter") {
    if (key === "Escape") return { kind: "exit-cmd-mode" };
    if (key === "Backspace") return { kind: "cmd-mode-backspace" };
    if (key.length === 1) return { kind: "cmd-mode-char", char: key };
    return undefined;
  }

  // 2. modal
  if (ctx.modalOpen) {
    if (key === "y") return { kind: "accept-approval" };
    if (key === "n") return { kind: "reject-approval" };
    if (key === "d") return { kind: "toggle-approval-detail" };
    if (key === "Escape") return { kind: "close-modal" };
    return undefined;
  }

  // 3. focused-card awaiting (y/n only; other keys fall through to grid)
  if (ctx.focusedAgentAwaiting) {
    if (key === "y") return { kind: "accept-focused-approval" };
    if (key === "n") return { kind: "reject-focused-approval" };
  }

  // 4. drill open
  if (ctx.drillOpen) {
    if (key === "Tab") return { kind: "cycle-drill-tab" };
    if (key === "1") return { kind: "set-drill-tab", tab: "feed" };
    if (key === "2") return { kind: "set-drill-tab", tab: "dag" };
    if (key === "3") return { kind: "set-drill-tab", tab: "term" };
    if (key === "Escape") return { kind: "close-drill" };
  }

  // 5. grid keys
  switch (key) {
    case "h": return { kind: "cursor-left" };
    case "j": return { kind: "cursor-down" };
    case "k": return { kind: "cursor-up" };
    case "l": return { kind: "cursor-right" };
    case "g": return { kind: "cursor-top" };
    case "G": return { kind: "cursor-bottom" };
    case "Enter":
    case "o":
      return { kind: "open-drill" };
    case "A": return { kind: "open-next-approval" };
    case "B": return { kind: "back-to-main" };
    case "/": return { kind: "enter-filter" };
    case "s": return { kind: "cycle-sort" };
    case "f": return { kind: "cycle-state-filter" };
    case "c": return { kind: "copy-agent-id" };
    default: return undefined;
  }
}
