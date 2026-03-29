/**
 * Parity matrix enforcement tests.
 *
 * Verifies that all shared operations have implementations on required surfaces.
 * This test acts as a CI gate — adding a new operation without updating all
 * surfaces causes a test failure.
 */

import { describe, expect, test } from "bun:test";

/**
 * Shared operations that MUST have MCP tool implementations.
 * Each entry maps an operation name to the expected MCP tool name.
 */
const SHARED_OPERATIONS_MCP: ReadonlyArray<{
  operation: string;
  mcpTool: string;
}> = [
  { operation: "contributeOperation", mcpTool: "grove_submit_work" },
  { operation: "reviewOperation", mcpTool: "grove_submit_review" },
  { operation: "adoptOperation", mcpTool: "grove_adopt" },
  { operation: "reproduceOperation", mcpTool: "grove_reproduce" },
  { operation: "discussOperation", mcpTool: "grove_discuss" },
  { operation: "claimOperation", mcpTool: "grove_claim" },
  { operation: "releaseOperation", mcpTool: "grove_release" },
  { operation: "frontierOperation", mcpTool: "grove_frontier" },
  { operation: "searchOperation", mcpTool: "grove_search" },
  { operation: "logOperation", mcpTool: "grove_log" },
  { operation: "treeOperation", mcpTool: "grove_tree" },
  { operation: "threadOperation", mcpTool: "grove_thread" },
  { operation: "checkoutOperation", mcpTool: "grove_checkout" },
  { operation: "listClaimsOperation", mcpTool: "grove_list_claims" },
  { operation: "createBountyOperation", mcpTool: "grove_bounty_create" },
  { operation: "listBountiesOperation", mcpTool: "grove_bounty_list" },
  { operation: "claimBountyOperation", mcpTool: "grove_claim" },
  { operation: "threadsOperation", mcpTool: "grove_threads" },
  { operation: "setOutcomeOperation", mcpTool: "grove_set_outcome" },
  { operation: "getOutcomeOperation", mcpTool: "grove_get_outcome" },
  { operation: "listOutcomesOperation", mcpTool: "grove_list_outcomes" },
  { operation: "outcomeStatsOperation", mcpTool: "grove_outcome_stats" },
];

/**
 * Shared operations that MUST have CLI command implementations.
 * Each entry maps an operation name to the expected CLI command name.
 */
const SHARED_OPERATIONS_CLI: ReadonlyArray<{
  operation: string;
  cliCommand: string;
}> = [
  { operation: "contributeOperation", cliCommand: "contribute" },
  { operation: "reviewOperation", cliCommand: "review" },
  { operation: "reproduceOperation", cliCommand: "reproduce" },
  { operation: "discussOperation", cliCommand: "discuss" },
  { operation: "claimOperation", cliCommand: "claim" },
  { operation: "releaseOperation", cliCommand: "release" },
  { operation: "frontierOperation", cliCommand: "frontier" },
  { operation: "searchOperation", cliCommand: "search" },
  { operation: "logOperation", cliCommand: "log" },
  { operation: "treeOperation", cliCommand: "tree" },
  { operation: "threadOperation", cliCommand: "thread" },
  { operation: "threadsOperation", cliCommand: "threads" },
  { operation: "checkoutOperation", cliCommand: "checkout" },
  { operation: "listClaimsOperation", cliCommand: "claims" },
];

describe("parity matrix: operations layer exports", () => {
  test("all shared operations are exported from index", async () => {
    const ops = await import("./index.js");

    const expectedExports = [
      "adoptOperation",
      "contributeOperation",
      "reviewOperation",
      "reproduceOperation",
      "discussOperation",
      "claimOperation",
      "releaseOperation",
      "listClaimsOperation",
      "frontierOperation",
      "searchOperation",
      "logOperation",
      "treeOperation",
      "threadOperation",
      "threadsOperation",
      "checkoutOperation",
      "checkStopOperation",
      "createBountyOperation",
      "listBountiesOperation",
      "claimBountyOperation",
      "settleBountyOperation",
      "setOutcomeOperation",
      "getOutcomeOperation",
      "listOutcomesOperation",
      "outcomeStatsOperation",
    ];

    for (const name of expectedExports) {
      expect(typeof (ops as Record<string, unknown>)[name]).toBe("function");
    }
  });
});

describe("parity matrix: MCP surface coverage", () => {
  test("all shared operations have MCP tool registrations", async () => {
    // Read MCP tool files to verify tool names exist
    const { Glob } = await import("bun");
    const toolFiles = new Glob("src/mcp/tools/*.ts").scanSync({
      cwd: process.cwd(),
      absolute: true,
    });

    let allToolSource = "";
    for (const file of toolFiles) {
      if (file.endsWith(".test.ts")) continue;
      const content = await Bun.file(file).text();
      allToolSource += content;
    }

    for (const { mcpTool } of SHARED_OPERATIONS_MCP) {
      expect(allToolSource).toContain(`"${mcpTool}"`);
    }
  });
});

describe("parity matrix: CLI surface coverage", () => {
  test("all shared CLI operations have command registrations", async () => {
    // Read main.ts to verify command names exist
    const mainSource = await Bun.file("src/cli/main.ts").text();

    for (const { cliCommand } of SHARED_OPERATIONS_CLI) {
      expect(mainSource).toContain(`name: "${cliCommand}"`);
    }
  });
});

describe("parity matrix: error code parity", () => {
  test("OperationErrorCode and McpErrorCode have identical values", async () => {
    const { OperationErrorCode } = await import("./result.js");
    const { McpErrorCode } = await import("../../mcp/error-handler.js");

    const opCodes = new Set(Object.values(OperationErrorCode));
    const mcpCodes = new Set(Object.values(McpErrorCode));

    // Every MCP code must be in operations
    for (const code of mcpCodes) {
      expect(opCodes.has(code)).toBe(true);
    }

    // Every operation code must be in MCP
    for (const code of opCodes) {
      expect(mcpCodes.has(code)).toBe(true);
    }
  });
});
