/**
 * Hints for the running view (#309).
 *
 * Excluded shortcuts:
 *   - `[Esc]Back` — Esc at root running depth is a no-op. The running
 *     screen is reached via `pages.resetTo({running})` from the wizard,
 *     so depth=1; PagesRouter does not pop bare Escape, and routeRunningKey's
 *     escape path with no overlay/filter/panel state just swallows the key.
 *     Restore when a true "back to dashboard / project picker" action exists.
 *
 * Panel toggle keys are 1-4 (running-keyboard.ts:355-374).
 */
import { defineHints, type KeyAction } from "../data/hint-map.js";

export const RUNNING_VIEW_HINTS: readonly KeyAction[] = defineHints([
  { key: ":", label: "Goto" },
  { key: "/", label: "Filter" },
  { key: "1-4", label: "Panel" },
  { key: "?", label: "Help" },
  { key: "q", label: "Quit" },
]);
