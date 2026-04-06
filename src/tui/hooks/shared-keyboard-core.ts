/**
 * Shared keyboard primitives used by both Boardroom (routeKey) and
 * Running view (routeRunningKey).
 *
 * Extracts the two patterns that are structurally identical across both
 * handlers to prevent independent divergence:
 *   - Modal input swallowing (returns true without dispatching)
 *   - Help overlay toggle check
 *
 * Both handlers still own their unique Escape layering and action dispatch.
 */

import type { KeyEvent } from "@opentui/core";

// ---------------------------------------------------------------------------
// Modal swallow check
// ---------------------------------------------------------------------------

/**
 * Returns true if the given key event should be unconditionally swallowed
 * in a modal input mode (i.e., the mode captures all input and nothing else
 * should handle this key).
 *
 * This covers the pattern repeated in both handlers:
 *   - Characters/special keys that have no modal meaning → swallowed (true)
 *   - Keys that DO have modal meaning (escape, return, backspace, tab) →
 *     not swallowed (false), so the caller can handle them specifically.
 */
export function isModalSwallowed(key: KeyEvent): boolean {
  const input = key.name;
  // These keys always have specific handlers in modal modes — never swallow.
  if (
    input === "escape" ||
    input === "return" ||
    input === "backspace" ||
    input === "tab" ||
    input === "space"
  ) {
    return false;
  }
  // Ctrl sequences in modal mode — let the caller decide.
  if (key.ctrl) return false;
  // Everything else is swallowed.
  return true;
}

// ---------------------------------------------------------------------------
// Help overlay key check
// ---------------------------------------------------------------------------

/**
 * Returns true if this key event is the standard help toggle (? or Shift+/).
 * Used to identify the help toggle in both handlers consistently.
 */
export function isHelpToggleKey(key: KeyEvent): boolean {
  return key.name === "?" || (key.shift && key.name === "/");
}
