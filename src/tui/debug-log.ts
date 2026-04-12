/**
 * Temporary debug logger for e2e trace validation.
 * Writes to /tmp/grove-debug.log so it doesn't corrupt the TUI.
 *
 * Gated behind GROVE_DEBUG=1 — no-op in normal operation.
 */

import { appendFileSync } from "node:fs";

const LOG_PATH = "/tmp/grove-debug.log";
const ENABLED = process.env.GROVE_DEBUG === "1";

export function debugLog(tag: string, msg: string): void {
  if (!ENABLED) return;
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] [${tag}] ${msg}\n`);
  } catch {
    // non-fatal
  }
}
