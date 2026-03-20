/**
 * `grove grove-status` — show grove-level summary.
 *
 * Reads .grove/grove.json and prints grove name, mode, preset,
 * and total contribution count from the SQLite DB.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseGroveConfig } from "../../core/config.js";
import { resolveGroveDir } from "../utils/grove-dir.js";

export async function handleGroveStatus(groveOverride?: string): Promise<void> {
  const { groveDir, dbPath } = resolveGroveDir(groveOverride);

  // Read grove.json
  const raw = readFileSync(join(groveDir, "grove.json"), "utf-8");
  const config = parseGroveConfig(raw);

  // Count contributions from SQLite
  const { initSqliteDb } = await import("../../local/sqlite-store.js");
  const db = initSqliteDb(dbPath);
  let count = 0;
  try {
    const row = db.prepare("SELECT COUNT(*) as cnt FROM contributions").get() as
      | { cnt: number }
      | undefined;
    count = row?.cnt ?? 0;
  } finally {
    db.close();
  }

  console.log(`Grove:          ${config.name}`);
  console.log(`Mode:           ${config.mode}`);
  console.log(`Preset:         ${config.preset ?? "none"}`);
  console.log(`Contributions:  ${count}`);
}
