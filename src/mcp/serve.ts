#!/usr/bin/env bun
/**
 * Grove MCP server entry point — stdio transport.
 *
 * Discovers the .grove directory, initializes stores, creates the MCP server,
 * and connects it to a StdioServerTransport. Designed to be spawned by
 * Claude Code, Codex, Cline, Goose, Copilot, or any MCP-compatible agent.
 *
 * Usage:
 *   grove-mcp                    # auto-discover .grove in cwd or parent dirs
 *   GROVE_DIR=/path grove-mcp    # explicit grove directory
 */

import { join } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { findGroveDir } from "../cli/context.js";
import { DefaultFrontierCalculator } from "../core/frontier.js";
import { FsCas } from "../local/fs-cas.js";
import { initSqliteDb, SqliteClaimStore, SqliteContributionStore } from "../local/sqlite-store.js";
import { LocalWorkspaceManager } from "../local/workspace.js";
import type { McpDeps } from "./deps.js";
import { createMcpServer } from "./server.js";

// --- Initialization (eager — catches config errors at startup) ------------

const groveOverride = process.env.GROVE_DIR ?? undefined;
const cwd = process.cwd();

let deps: McpDeps;
let close: () => void;

try {
  const groveDir = groveOverride ?? findGroveDir(cwd);
  if (groveDir === undefined) {
    throw new Error("Not inside a grove. Run 'grove init' to create one, or set GROVE_DIR.");
  }

  const dbPath = join(groveDir, "grove.db");
  const casPath = join(groveDir, "cas");

  const db = initSqliteDb(dbPath);
  const contributionStore = new SqliteContributionStore(db);
  const claimStore = new SqliteClaimStore(db);
  const cas = new FsCas(casPath);
  const frontier = new DefaultFrontierCalculator(contributionStore);
  const workspace = new LocalWorkspaceManager({
    groveRoot: groveDir,
    db,
    contributionStore,
    cas,
  });

  deps = { contributionStore, claimStore, cas, frontier, workspace };
  close = () => {
    workspace.close();
    db.close();
  };
} catch (error) {
  // Write to stderr (stdout is reserved for MCP JSON-RPC)
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`grove-mcp: ${message}\n`);
  process.exit(1);
}

// --- Server setup ---------------------------------------------------------

const server = createMcpServer(deps);
const transport = new StdioServerTransport();

await server.connect(transport);

// Graceful shutdown
const shutdown = async (): Promise<void> => {
  await server.close();
  close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
