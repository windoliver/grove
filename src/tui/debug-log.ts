/**
 * Temporary debug logger for e2e trace validation.
 * Writes to /tmp/grove-debug.log so it doesn't corrupt the TUI.
 */

import { appendFileSync } from "node:fs";

const LOG_PATH = "/tmp/grove-debug.log";

export function debugLog(tag: string, msg: string): void {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] [${tag}] ${msg}\n`);
  } catch {
    // non-fatal
  }
}
