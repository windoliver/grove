/**
 * Temporary debug logger for e2e trace validation.
 * Writes outside the TUI alternate screen so it doesn't corrupt rendering.
 *
 * Gated behind GROVE_DEBUG=1 or GROVE_DEBUG_LOG — no-op in normal operation.
 */

import { appendFileSync } from "node:fs";

const LOG_PATH = process.env.GROVE_DEBUG_LOG ?? "/tmp/grove-debug.log";
const ENABLED = process.env.GROVE_DEBUG === "1" || process.env.GROVE_DEBUG_LOG !== undefined;

export function debugLog(tag: string, msg: string): void {
  if (!ENABLED) return;
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] [${tag}] ${msg}\n`);
  } catch {
    // non-fatal
  }
}
