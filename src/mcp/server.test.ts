/**
 * Tests for preset-scoped MCP tool registration.
 *
 * Verifies that:
 * 1. Default (no preset) registers all tools.
 * 2. Preset flags selectively exclude tool groups.
 * 3. Contribution tools are always registered regardless of preset.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpDeps } from "./deps.js";
import type { McpPresetConfig } from "./server.js";
import { createMcpServer } from "./server.js";
import type { TestMcpDeps } from "./test-helpers.js";
import { createTestMcpDeps } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the list of registered tool names from a McpServer instance. */
function getRegisteredToolNames(server: McpServer): string[] {
  const internal = server as unknown as {
    _registeredTools: Record<string, unknown>;
  };
  return Object.keys(internal._registeredTools).sort();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMcpServer preset scoping", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  // --- Contribution tool names (always registered) -------------------------

  const contributionTools = [
    "grove_contribute",
    "grove_discuss",
    "grove_reproduce",
    "grove_review",
  ];

  // --- Full tool list (matches integration test expectation) ---------------

  const allTools = [
    "ask_user",
    "grove_bounty_claim",
    "grove_bounty_create",
    "grove_bounty_list",
    "grove_bounty_settle",
    "grove_cas_put",
    "grove_check_stop",
    "grove_checkout",
    "grove_claim",
    "grove_contribute",
    "grove_create_plan",
    "grove_create_session",
    "grove_discuss",
    "grove_done",
    "grove_frontier",
    "grove_get_outcome",
    "grove_goal",
    "grove_ingest_git_diff",
    "grove_ingest_git_tree",
    "grove_list_claims",
    "grove_list_outcomes",
    "grove_list_sessions",
    "grove_log",
    "grove_outcome_stats",
    "grove_read_inbox",
    "grove_release",
    "grove_report_usage",
    "grove_reproduce",
    "grove_review",
    "grove_search",
    "grove_send_message",
    "grove_set_goal",
    "grove_set_outcome",
    "grove_thread",
    "grove_threads",
    "grove_tree",
    "grove_update_plan",
  ];

  // -----------------------------------------------------------------------

  test("no preset registers all tools (backwards compatible)", async () => {
    const server = await createMcpServer(deps);
    const names = getRegisteredToolNames(server);
    expect(names).toEqual(allTools);
  });

  test("empty preset object registers all tools (defaults are true)", async () => {
    const server = await createMcpServer(deps, {});
    const names = getRegisteredToolNames(server);
    expect(names).toEqual(allTools);
  });

  test("claims: false excludes claim tools but keeps others", async () => {
    const server = await createMcpServer(deps, { claims: false });
    const names = getRegisteredToolNames(server);

    const claimTools = ["grove_claim", "grove_release", "grove_list_claims"];
    for (const t of claimTools) {
      expect(names).not.toContain(t);
    }
    // Contribution tools still present
    for (const t of contributionTools) {
      expect(names).toContain(t);
    }
    // Query tools still present
    expect(names).toContain("grove_frontier");
  });

  test("bounties: false excludes bounty tools", async () => {
    const server = await createMcpServer(deps, { bounties: false });
    const names = getRegisteredToolNames(server);

    const bountyTools = [
      "grove_bounty_create",
      "grove_bounty_list",
      "grove_bounty_claim",
      "grove_bounty_settle",
    ];
    for (const t of bountyTools) {
      expect(names).not.toContain(t);
    }
    // Contributions always present
    for (const t of contributionTools) {
      expect(names).toContain(t);
    }
  });

  test("outcomes: false excludes outcome tools", async () => {
    const server = await createMcpServer(deps, { outcomes: false });
    const names = getRegisteredToolNames(server);

    const outcomeTools = [
      "grove_set_outcome",
      "grove_get_outcome",
      "grove_list_outcomes",
      "grove_outcome_stats",
    ];
    for (const t of outcomeTools) {
      expect(names).not.toContain(t);
    }
  });

  test("stop: false excludes stop tools", async () => {
    const server = await createMcpServer(deps, { stop: false });
    const names = getRegisteredToolNames(server);
    expect(names).not.toContain("grove_check_stop");
  });

  test("workspace: false excludes workspace tools", async () => {
    const server = await createMcpServer(deps, { workspace: false });
    const names = getRegisteredToolNames(server);
    expect(names).not.toContain("grove_checkout");
  });

  test("queries: false excludes query tools", async () => {
    const server = await createMcpServer(deps, { queries: false });
    const names = getRegisteredToolNames(server);

    const queryTools = [
      "grove_frontier",
      "grove_search",
      "grove_log",
      "grove_tree",
      "grove_thread",
      "grove_threads",
    ];
    for (const t of queryTools) {
      expect(names).not.toContain(t);
    }
  });

  test("ingest: false excludes ingest tools", async () => {
    const server = await createMcpServer(deps, { ingest: false });
    const names = getRegisteredToolNames(server);

    const ingestTools = ["grove_cas_put", "grove_ingest_git_diff", "grove_ingest_git_tree"];
    for (const t of ingestTools) {
      expect(names).not.toContain(t);
    }
  });

  test("messaging: false excludes messaging tools", async () => {
    const server = await createMcpServer(deps, { messaging: false });
    const names = getRegisteredToolNames(server);

    const messagingTools = ["grove_send_message", "grove_read_inbox", "grove_report_usage"];
    for (const t of messagingTools) {
      expect(names).not.toContain(t);
    }
  });

  test("plans: false excludes plan tools", async () => {
    const server = await createMcpServer(deps, { plans: false });
    const names = getRegisteredToolNames(server);

    const planTools = ["grove_create_plan", "grove_update_plan"];
    for (const t of planTools) {
      expect(names).not.toContain(t);
    }
  });

  test("goals: false excludes goal and session tools", async () => {
    const server = await createMcpServer(deps, { goals: false });
    const names = getRegisteredToolNames(server);

    const goalTools = [
      "grove_goal",
      "grove_set_goal",
      "grove_create_session",
      "grove_list_sessions",
    ];
    for (const t of goalTools) {
      expect(names).not.toContain(t);
    }
  });

  test("contribution tools are always registered even when everything is disabled", async () => {
    const allDisabled: McpPresetConfig = {
      queries: false,
      claims: false,
      bounties: false,
      outcomes: false,
      workspace: false,
      stop: false,
      ingest: false,
      messaging: false,
      plans: false,
      goals: false,
    };

    const server = await createMcpServer(deps, allDisabled);
    const names = getRegisteredToolNames(server);

    // Contribution tools always present
    for (const t of contributionTools) {
      expect(names).toContain(t);
    }

    // ask_user always present
    expect(names).toContain("ask_user");

    // Only contribution tools + done + ask_user
    expect(names).toEqual(["ask_user", "grove_done", ...contributionTools].sort());
  });

  test("review-loop preset example (selective disabling)", async () => {
    const reviewLoopPreset: McpPresetConfig = {
      claims: false,
      bounties: false,
      outcomes: false,
      stop: false,
    };

    const server = await createMcpServer(deps, reviewLoopPreset);
    const names = getRegisteredToolNames(server);

    // Excluded groups
    expect(names).not.toContain("grove_claim");
    expect(names).not.toContain("grove_bounty_create");
    expect(names).not.toContain("grove_set_outcome");
    expect(names).not.toContain("grove_check_stop");

    // Included groups
    expect(names).toContain("grove_contribute");
    expect(names).toContain("grove_frontier");
    expect(names).toContain("grove_checkout");
    expect(names).toContain("grove_send_message");
    expect(names).toContain("grove_create_plan");
    expect(names).toContain("grove_goal");
  });
});
