/**
 * Grove HTTP server entry point.
 *
 * Creates stores from environment/flags and starts Bun.serve().
 * This is the only file excluded from test coverage — use createApp() for testing.
 */

import { join } from "node:path";
import { DefaultFrontierCalculator } from "../core/frontier.js";
import { FsCas } from "../local/fs-cas.js";
import { createSqliteStores } from "../local/sqlite-store.js";
import { createApp } from "./app.js";

const GROVE_DIR = process.env.GROVE_DIR ?? join(process.cwd(), ".grove");
const PORT = Number(process.env.PORT ?? 4515);

const dbPath = join(GROVE_DIR, "grove.db");
const casDir = join(GROVE_DIR, "cas");

const stores = createSqliteStores(dbPath);
const cas = new FsCas(casDir);
const frontier = new DefaultFrontierCalculator(stores.contributionStore);

const app = createApp({
  contributionStore: stores.contributionStore,
  claimStore: stores.claimStore,
  cas,
  frontier,
});

const server = Bun.serve({
  port: PORT,
  fetch: app.fetch,
});

console.log(`grove-server listening on http://localhost:${server.port}`);

// Graceful shutdown
function shutdown(): void {
  console.log("Shutting down...");
  server.stop();
  stores.close();
  cas.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
