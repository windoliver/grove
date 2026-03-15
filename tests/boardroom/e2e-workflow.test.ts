/**
 * End-to-end boardroom workflow test.
 *
 * Validates the complete boardroom lifecycle using mock agents:
 * register profile → spawn → message → ask-user question →
 * operator answer → contribute → cost report → verify state.
 *
 * Uses InMemoryContributionStore to avoid external dependencies.
 * (Issue #90, Decision 12A)
 */

import { describe, expect, test } from "bun:test";

import {
  parseAgentProfiles,
  serializeAgentProfiles,
  validateProfilesAgainstTopology,
} from "../../src/core/agent-profile.js";
import type { AgentIdentity, ContributionInput } from "../../src/core/models.js";
import { ContributionKind, RelationType } from "../../src/core/models.js";
import {
  answerQuestion,
  getAnswer,
  listPendingQuestions,
  submitQuestion,
} from "../../src/core/operations/ask-user-bus.js";
import { getSessionCosts, reportUsage } from "../../src/core/operations/cost-tracking.js";
import { readInbox, sendMessage } from "../../src/core/operations/messaging.js";
import type { AgentTopology } from "../../src/core/topology.js";

// ---------------------------------------------------------------------------
// Minimal in-memory contribution store for testing
// ---------------------------------------------------------------------------

class InMemoryStore {
  private readonly contributions = new Map<string, Contribution>();

  async put(c: Contribution): Promise<void> {
    this.contributions.set(c.cid, c);
  }
  async putMany(cs: readonly Contribution[]): Promise<void> {
    for (const c of cs) this.contributions.set(c.cid, c);
  }
  async get(cid: string): Promise<Contribution | undefined> {
    return this.contributions.get(cid);
  }
  async getMany(cids: readonly string[]): Promise<ReadonlyMap<string, Contribution>> {
    const map = new Map<string, Contribution>();
    for (const cid of cids) {
      const c = this.contributions.get(cid);
      if (c) map.set(cid, c);
    }
    return map;
  }
  async list(query?: {
    kind?: string;
    limit?: number;
    offset?: number;
    tags?: readonly string[];
    agentId?: string;
    agentName?: string;
    mode?: string;
  }): Promise<readonly Contribution[]> {
    let result = [...this.contributions.values()];
    if (query?.kind) result = result.filter((c) => c.kind === query.kind);
    if (query?.agentId) result = result.filter((c) => c.agent.agentId === query.agentId);
    if (query?.tags) {
      const tags = query.tags;
      result = result.filter((c) => tags.every((t) => c.tags.includes(t)));
    }
    result.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    if (query?.limit) result = result.slice(query.offset ?? 0, (query.offset ?? 0) + query.limit);
    return result;
  }
  async children(cid: string): Promise<readonly Contribution[]> {
    return [...this.contributions.values()].filter((c) =>
      c.relations.some((r) => r.targetCid === cid),
    );
  }
  async ancestors(cid: string): Promise<readonly Contribution[]> {
    const c = this.contributions.get(cid);
    if (!c) return [];
    const targetCids = c.relations.map((r) => r.targetCid);
    return targetCids
      .map((t) => this.contributions.get(t))
      .filter((x): x is Contribution => x !== undefined);
  }
  async relationsOf(cid: string, relationType?: string) {
    const c = this.contributions.get(cid);
    if (!c) return [];
    return relationType ? c.relations.filter((r) => r.relationType === relationType) : c.relations;
  }
  async relatedTo(cid: string, relationType?: string): Promise<readonly Contribution[]> {
    return [...this.contributions.values()].filter((c) =>
      c.relations.some(
        (r) =>
          r.targetCid === cid && (relationType === undefined || r.relationType === relationType),
      ),
    );
  }
  async search() {
    return [];
  }
  async findExisting() {
    return [];
  }
  async count() {
    return this.contributions.size;
  }
  async thread() {
    return [];
  }
  async replyCounts() {
    return new Map();
  }
  async hotThreads() {
    return [];
  }
  close() {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let cidCounter = 0;
function mockComputeCid(_input: ContributionInput): string {
  cidCounter++;
  return `blake3:${"0".repeat(60)}${String(cidCounter).padStart(4, "0")}`;
}

const topology: AgentTopology = {
  structure: "graph",
  roles: [
    {
      name: "reviewer",
      description: "Reviews code",
      maxInstances: 3,
      edges: [{ target: "analyst", edgeType: "delegates" }],
      command: "claude --role reviewer",
      platform: "claude-code",
    },
    {
      name: "analyst",
      description: "Analyzes code",
      maxInstances: 2,
      edges: [{ target: "reviewer", edgeType: "reports" }],
      command: "claude --role analyst",
      platform: "claude-code",
    },
  ],
};

const agent1: AgentIdentity = {
  agentId: "claude-eng-1",
  agentName: "@claude-eng",
  platform: "claude-code",
  model: "claude-opus-4-6",
  role: "reviewer",
};

const agent2: AgentIdentity = {
  agentId: "codex-rev-1",
  agentName: "@codex-rev",
  platform: "codex",
  role: "analyst",
};

const operator: AgentIdentity = {
  agentId: "operator",
  agentName: "operator",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E boardroom workflow", () => {
  test("complete lifecycle: profile → message → ask-user → cost → verify", async () => {
    const store = new InMemoryStore();
    cidCounter = 0;

    // Step 1: Register agent profiles (validate against topology)
    const profiles = [
      {
        name: "@claude-eng" as const,
        role: "reviewer" as const,
        platform: "claude-code" as const,
        model: "claude-opus-4-6",
        color: "#00cccc",
      },
      {
        name: "@codex-rev" as const,
        role: "analyst" as const,
        platform: "codex" as const,
        color: "#ff6600",
      },
    ];

    // Validate profiles against topology
    validateProfilesAgainstTopology(profiles, topology);

    // Serialize and round-trip
    const json = serializeAgentProfiles(profiles);
    const parsed = parseAgentProfiles(json);
    expect(parsed.profiles).toHaveLength(2);
    expect(parsed.profiles[0]?.name).toBe("@claude-eng");

    // Step 2: Agent 1 sends a message to Agent 2
    const msg = await sendMessage(
      store as never,
      {
        agent: agent1,
        body: "I've started reviewing the auth module, line 42 looks suspicious",
        recipients: ["@codex-rev"],
        tags: ["review"],
      },
      mockComputeCid,
    );

    expect(msg.kind).toBe(ContributionKind.Discussion);
    expect(msg.context?.ephemeral).toBe(true);
    expect(msg.context?.recipients).toEqual(["@codex-rev"]);

    // Step 3: Agent 2 replies
    const reply = await sendMessage(
      store as never,
      {
        agent: agent2,
        body: "Good catch, that's a SQL injection vector. I'll analyze further.",
        recipients: ["@claude-eng"],
        inReplyTo: msg.cid,
      },
      mockComputeCid,
    );

    expect(reply.relations).toHaveLength(1);
    expect(reply.relations[0]?.relationType).toBe(RelationType.RespondsTo);
    expect(reply.relations[0]?.targetCid).toBe(msg.cid);

    // Step 4: Read inbox for Agent 2 — should see Agent 1's message
    const agent2Inbox = await readInbox(store as never, {
      recipient: "@codex-rev",
    });
    expect(agent2Inbox.length).toBeGreaterThanOrEqual(1);
    expect(agent2Inbox.some((m) => m.body.includes("auth module"))).toBe(true);

    // Step 5: Agent 1 asks a question via ask-user
    const question = await submitQuestion(
      store as never,
      {
        agent: agent1,
        question: "Should I fix this SQL injection now or file it as a separate issue?",
        options: ["Fix now", "File issue"],
        ttlSeconds: 300,
      },
      mockComputeCid,
    );

    expect(question.context?.ask_user_question).toBe(true);

    // Step 6: Verify question is pending
    let pending = await listPendingQuestions(store as never);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.question).toContain("SQL injection");

    // Step 7: Operator answers the question
    await answerQuestion(
      store as never,
      {
        questionCid: question.cid,
        answer: "Fix now",
        operator,
      },
      mockComputeCid,
    );

    // Step 8: Verify question is no longer pending
    pending = await listPendingQuestions(store as never);
    expect(pending).toHaveLength(0);

    // Step 9: Agent reads the answer
    const answer = await getAnswer(store as never, question.cid);
    expect(answer).toBe("Fix now");

    // Step 10: Both agents report usage
    await reportUsage(
      store as never,
      agent1,
      {
        inputTokens: 50_000,
        outputTokens: 12_000,
        costUsd: 0.42,
        model: "claude-opus-4-6",
        contextWindowPercent: 78,
      },
      mockComputeCid,
    );

    await reportUsage(
      store as never,
      agent2,
      {
        inputTokens: 30_000,
        outputTokens: 8_000,
        costUsd: 0.18,
        model: "codex-latest",
      },
      mockComputeCid,
    );

    // Step 11: Query session costs
    const costs = await getSessionCosts(store as never);
    expect(costs.byAgent).toHaveLength(2);
    expect(costs.totalCostUsd).toBeCloseTo(0.6, 2);
    expect(costs.totalInputTokens).toBe(80_000);
    expect(costs.totalOutputTokens).toBe(20_000);

    // Verify agent breakdown
    const agent1Cost = costs.byAgent.find((a) => a.agentId === "claude-eng-1");
    expect(agent1Cost?.totalCostUsd).toBeCloseTo(0.42, 2);
    expect(agent1Cost?.latestContextPercent).toBe(78);

    const agent2Cost = costs.byAgent.find((a) => a.agentId === "codex-rev-1");
    expect(agent2Cost?.totalCostUsd).toBeCloseTo(0.18, 2);

    // Step 12: Verify total contribution count
    // Messages(2) + question(1) + answer(1) + usage reports(2) = 6
    const totalCount = await store.count();
    expect(totalCount).toBe(6);

    // Verify all contributions are ephemeral
    const all = await store.list();
    for (const c of all) {
      expect(c.context?.ephemeral).toBe(true);
    }
  });

  test("concurrent questions from multiple agents", async () => {
    const store = new InMemoryStore();
    cidCounter = 100;

    // Two agents ask simultaneously
    const q1 = await submitQuestion(
      store as never,
      {
        agent: agent1,
        question: "Should I proceed with approach A?",
        options: ["Yes", "No"],
      },
      mockComputeCid,
    );

    const q2 = await submitQuestion(
      store as never,
      {
        agent: agent2,
        question: "Is the test coverage sufficient?",
        options: ["Yes", "Add more tests"],
      },
      mockComputeCid,
    );

    // Both should be pending
    const pending = await listPendingQuestions(store as never);
    expect(pending).toHaveLength(2);

    // Answer one
    await answerQuestion(
      store as never,
      {
        questionCid: q1.cid,
        answer: "Yes",
        operator,
      },
      mockComputeCid,
    );

    // Only one should remain pending
    const stillPending = await listPendingQuestions(store as never);
    expect(stillPending).toHaveLength(1);
    expect(stillPending[0]?.cid).toBe(q2.cid);
  });

  test("profile validation rejects undefined roles", () => {
    const badProfiles = [
      {
        name: "@bad-agent" as const,
        role: "nonexistent-role" as const,
        platform: "custom" as const,
      },
    ];

    expect(() => validateProfilesAgainstTopology(badProfiles, topology)).toThrow(
      "undefined role 'nonexistent-role'",
    );
  });

  test("profile validation rejects duplicate names", () => {
    const badProfiles = [
      { name: "@dup" as const, role: "reviewer" as const, platform: "custom" as const },
      { name: "@dup" as const, role: "analyst" as const, platform: "custom" as const },
    ];

    expect(() => validateProfilesAgainstTopology(badProfiles, topology)).toThrow("duplicate");
  });

  test("broadcast message reaches all recipients", async () => {
    const store = new InMemoryStore();
    cidCounter = 200;

    await sendMessage(
      store as never,
      {
        agent: agent1,
        body: "Team standup: what's everyone working on?",
        recipients: ["@all"],
      },
      mockComputeCid,
    );

    // Both agents should see the broadcast
    const inbox1 = await readInbox(store as never, { recipient: "@claude-eng" });
    const inbox2 = await readInbox(store as never, { recipient: "@codex-rev" });

    expect(inbox1).toHaveLength(1);
    expect(inbox2).toHaveLength(1);
    expect(inbox1[0]?.body).toContain("standup");
  });
});
