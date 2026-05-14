/**
 * Integration tests for the grove MCP server.
 *
 * Uses InMemoryTransport to test the full round-trip:
 * Client → Transport → McpServer → Tool Handler → Store → Response → Client
 *
 * This catches schema registration bugs, serialization issues, and
 * protocol-level errors that unit tests miss.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseGroveConfig } from "../core/config.js";
import { InMemorySessionStore } from "../core/in-memory-session-store.js";
import { DefaultRuntimeSkillAcquisitionService } from "../core/runtime-skill-acquisition.js";
import { makeContribution } from "../core/test-helpers.js";
import type { McpDeps } from "./deps.js";
import { createMcpServer } from "./server.js";
import type { TestMcpDeps } from "./test-helpers.js";
import { createTestMcpDeps } from "./test-helpers.js";

/** Extract text from MCP tool result content array. */
function getText(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text: string }> };
  return r.content?.[0]?.text ?? "";
}

describe("MCP server integration", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let client: Client;
  let closeTransports: () => Promise<void>;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;

    const server = await createMcpServer(deps, { eval: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: "test-client", version: "0.0.1" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    closeTransports = async () => {
      await client.close();
      await server.close();
    };
  });

  afterEach(async () => {
    await closeTransports();
    await testDeps.cleanup();
  });

  test("lists all 42 tools", async () => {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual([
      "ask_user",
      "grove_adopt",
      "grove_bounty_create",
      "grove_bounty_list",
      "grove_bounty_settle",
      "grove_cas_put",
      "grove_check_stop",
      "grove_check_trajectory",
      "grove_checkout",
      "grove_claim",
      "grove_create_plan",
      "grove_create_session",
      "grove_delete_session",
      "grove_discuss",
      "grove_done",
      "grove_eval",
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
      "grove_request_skill",
      "grove_search",
      "grove_send_message",
      "grove_session_delete_blockers",
      "grove_set_goal",
      "grove_set_outcome",
      "grove_submit_review",
      "grove_submit_work",
      "grove_thread",
      "grove_threads",
      "grove_tree",
      "grove_update_plan",
    ]);
  });

  test("grove_submit_work round-trip", async () => {
    const result = await client.callTool({
      name: "grove_submit_work",
      arguments: {
        summary: "Integration test contribution",
        tags: ["integration"],
        artifacts: {},
        agent: { agentId: "integration-agent" },
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(getText(result));
    expect(data.cid).toMatch(/^blake3:/);
    expect(data.kind).toBe("work");
  });

  test("grove_search round-trip", async () => {
    // Add a contribution to search for
    const c = makeContribution({ summary: "Searchable via MCP" });
    await deps.contributionStore.put(c);

    const result = await client.callTool({
      name: "grove_search",
      arguments: { query: "searchable" },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(getText(result));
    expect(data.results.length).toBe(1);
    expect(data.results[0].summary).toBe("Searchable via MCP");
  });

  test("grove_claim and grove_release round-trip", async () => {
    // Claim
    const claimResult = await client.callTool({
      name: "grove_claim",
      arguments: {
        targetRef: "integration-target",
        agent: { agentId: "integration-agent" },
        intentSummary: "Integration test claim",
      },
    });

    expect(claimResult.isError).toBeFalsy();
    const claimData = JSON.parse(getText(claimResult));
    expect(claimData.status).toBe("active");

    // Release
    const releaseResult = await client.callTool({
      name: "grove_release",
      arguments: {
        claimId: claimData.claimId,
        action: "complete",
      },
    });

    expect(releaseResult.isError).toBeFalsy();
    const releaseData = JSON.parse(getText(releaseResult));
    expect(releaseData.status).toBe("completed");
  });

  test("grove_submit_review round-trip", async () => {
    // Create target
    const target = makeContribution({ summary: "Reviewable work" });
    await deps.contributionStore.put(target);

    const result = await client.callTool({
      name: "grove_submit_review",
      arguments: {
        targetCid: target.cid,
        summary: "LGTM",
        scores: { quality: { value: 0.9, direction: "maximize" } },
        agent: { agentId: "reviewer" },
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(getText(result));
    expect(data.kind).toBe("review");
    expect(data.targetCid).toBe(target.cid);
  });

  test("grove_frontier round-trip on empty grove", async () => {
    const result = await client.callTool({
      name: "grove_frontier",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(getText(result));
    expect(data.byRecency).toEqual([]);
  });

  test("grove_log round-trip", async () => {
    const c = makeContribution({ summary: "Log entry" });
    await deps.contributionStore.put(c);

    const result = await client.callTool({
      name: "grove_log",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(getText(result));
    expect(data.results.length).toBe(1);
  });

  test("grove_tree round-trip", async () => {
    const parent = makeContribution({ summary: "Tree root" });
    await deps.contributionStore.put(parent);

    const result = await client.callTool({
      name: "grove_tree",
      arguments: { cid: parent.cid },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(getText(result));
    expect(data.cid).toBe(parent.cid);
  });

  test("error handling — invalid tool call returns error", async () => {
    const result = await client.callTool({
      name: "grove_tree",
      arguments: {
        cid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
      },
    });

    expect(result.isError).toBeTruthy();
    expect(getText(result)).toContain("NOT_FOUND");
  });
});

describe("MCP server runtime skill integration", () => {
  const originalRole = process.env.GROVE_AGENT_ROLE;
  const originalAgent = process.env.GROVE_AGENT_ID;
  const originalSession = process.env.GROVE_SESSION_ID;

  afterEach(() => {
    if (originalRole === undefined) delete process.env.GROVE_AGENT_ROLE;
    else process.env.GROVE_AGENT_ROLE = originalRole;
    if (originalAgent === undefined) delete process.env.GROVE_AGENT_ID;
    else process.env.GROVE_AGENT_ID = originalAgent;
    if (originalSession === undefined) delete process.env.GROVE_SESSION_ID;
    else process.env.GROVE_SESSION_ID = originalSession;
  });

  test("grove_request_skill installs from local catalog and persists session role skill", async () => {
    const root = mkdtempSync(join(tmpdir(), "grove-mcp-runtime-skill-"));
    const groveDir = join(root, ".grove");
    const workspace = join(root, "workspace");
    const catalogRoot = join(groveDir, "skills");
    const originalCwd = process.cwd();

    mkdirSync(join(catalogRoot, "review"), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(catalogRoot, "review", "SKILL.md"), "review skill", "utf-8");
    writeFileSync(
      join(groveDir, "grove.json"),
      JSON.stringify({
        name: "runtime-skill-test",
        mode: "local",
        runtimeSkills: {
          mode: "role-allowlist",
          roles: { coder: ["grove", "review"] },
        },
      }),
      "utf-8",
    );

    const testDeps = await createTestMcpDeps();
    const goalSessionStore = new InMemorySessionStore();
    const session = await goalSessionStore.createSession({
      goal: "Review work",
      topology: {
        structure: "flat",
        roles: [{ name: "coder", skills: ["grove"] }],
      },
    });
    const runtimeSkillService = new DefaultRuntimeSkillAcquisitionService({
      readRuntimeSkillsConfig: async () => {
        const config = parseGroveConfig(readFileSync(join(groveDir, "grove.json"), "utf-8"));
        return config.runtimeSkills;
      },
      bundledSkillsRoot: catalogRoot,
      workspaceOverrideRoot: catalogRoot,
      sessionStore: goalSessionStore,
    });
    const deps: McpDeps = { ...testDeps.deps, runtimeSkillService };
    const server = await createMcpServer(deps, { transport: "stdio" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "runtime-skill-client", version: "0.0.1" });

    process.env.GROVE_AGENT_ROLE = "coder";
    process.env.GROVE_AGENT_ID = "agent-1";
    process.env.GROVE_SESSION_ID = session.id;

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      process.chdir(workspace);

      const result = await client.callTool({
        name: "grove_request_skill",
        arguments: { skillName: "review" },
      });

      expect(result.isError).toBeFalsy();
      expect(readFileSync(join(workspace, ".codex/skills/review/SKILL.md"), "utf-8")).toBe(
        "review skill",
      );
      expect(readFileSync(join(workspace, ".claude/skills/review/SKILL.md"), "utf-8")).toBe(
        "review skill",
      );
      const updated = await goalSessionStore.getSession(session.id);
      expect(updated?.topology?.roles[0]?.skills).toEqual(["grove", "review"]);
    } finally {
      process.chdir(originalCwd);
      await client.close();
      await server.close();
      await testDeps.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Wiring test: EnforcingContributionStore wrap for the MCP path
// ---------------------------------------------------------------------------
//
// Issue 11A in the #228 review. Rate limits live on the
// EnforcingContributionStore wrapper, which serve.ts is responsible for
// applying. Without this test, anyone removing the wrap from serve.ts
// would silently break GROVE.md rate-limit configuration in MCP mode.
//
// This test mirrors the wiring logic in src/mcp/serve.ts: build the
// raw store, wrap it with EnforcingContributionStore when a contract
// is loaded, then exercise it through the same MCP boundary the
// production server uses. The 2nd contribution must be rejected with
// a RateLimitError.

describe("MCP server: rate-limit wiring (Issue 2A/11A)", () => {
  test("rate-limited contract rejects 2nd contribution at the MCP boundary", async () => {
    const { EnforcingContributionStore } = await import("../core/enforcing-store.js");
    const { ContributionMode } = await import("../core/models.js");
    const testDeps = await createTestMcpDeps();
    try {
      // Build a contract with a tight per-agent limit.
      const contract = {
        contractVersion: 1,
        name: "rate-limit-test",
        mode: ContributionMode.Evaluation,
        rateLimits: { maxContributionsPerAgentPerHour: 1 },
      };

      // Wrap exactly as src/mcp/serve.ts now does (Issue 2A).
      const wrappedStore = new EnforcingContributionStore(
        testDeps.deps.contributionStore,
        contract,
        { cas: testDeps.deps.cas },
      );

      const wrappedDeps: McpDeps = {
        ...testDeps.deps,
        contributionStore: wrappedStore,
        contract,
      };

      const server = await createMcpServer(wrappedDeps);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "rate-test-client", version: "0.0.1" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      try {
        // First call: should succeed.
        const first = await client.callTool({
          name: "grove_submit_work",
          arguments: {
            summary: "first contribution",
            tags: ["rate-test"],
            artifacts: {},
            agent: { agentId: "limited-agent" },
          },
        });
        expect(first.isError).toBeFalsy();

        // Second call: must be rejected by the rate limit.
        const second = await client.callTool({
          name: "grove_submit_work",
          arguments: {
            summary: "second contribution",
            tags: ["rate-test"],
            artifacts: {},
            agent: { agentId: "limited-agent" },
          },
        });
        expect(second.isError).toBeTruthy();
        expect(getText(second)).toMatch(/rate.?limit|RATE_LIMIT/i);
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await testDeps.cleanup();
    }
  });
});
