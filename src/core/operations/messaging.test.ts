/**
 * Tests for sendMessageAsDiscussion + readInbox.
 *
 * sendMessageAsDiscussion was previously the standalone `sendMessage`
 * helper that bypassed PolicyEnforcer/TopologyRouter (the #228 bug for
 * the messaging path). It now sugars over contributeOperation, so this
 * file also covers the regression test: a contract that disallows
 * `discussion` for an agent must reject sendMessageAsDiscussion.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { GroveContract } from "../contract.js";
import { EnforcingContributionStore } from "../enforcing-store.js";
import type { Contribution, ContributionInput } from "../models.js";
import { ContributionKind, ContributionMode, RelationType } from "../models.js";
import type { ContributionStore } from "../store.js";
import { InMemoryContributionStore } from "../testing.js";
import { _resetIdempotencyCacheForTests } from "./contribute.js";
import type { OperationDeps } from "./deps.js";
import { readInbox, sendMessageAsDiscussion } from "./messaging.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENT_ALICE = { agentId: "alice", agentName: "Alice" };
const AGENT_BOB = { agentId: "bob", agentName: "Bob" };

function makeDeps(store: ContributionStore, contract?: GroveContract): OperationDeps {
  return {
    contributionStore: store,
    ...(contract !== undefined ? { contract } : {}),
  };
}

// ---------------------------------------------------------------------------
// sendMessageAsDiscussion — happy path + validation
// ---------------------------------------------------------------------------

describe("sendMessageAsDiscussion", () => {
  beforeEach(() => {
    _resetIdempotencyCacheForTests();
  });

  afterEach(() => {
    _resetIdempotencyCacheForTests();
  });

  test("creates ephemeral discussion contribution with recipients", async () => {
    const store = new InMemoryContributionStore();
    const result = await sendMessageAsDiscussion(
      { agent: AGENT_ALICE, body: "Hello Bob!", recipients: ["@bob"] },
      makeDeps(store),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recipients).toEqual(["@bob"]);
    expect(result.value.summary).toBe("Hello Bob!");

    const stored = await store.get(result.value.cid);
    expect(stored?.kind).toBe(ContributionKind.Discussion);
    expect(stored?.mode).toBe(ContributionMode.Exploration);
    expect(stored?.context?.ephemeral).toBe(true);
    expect(stored?.context?.recipients).toEqual(["@bob"]);
    expect(stored?.context?.message_body).toBe("Hello Bob!");
    expect(stored?.tags).toContain("message");
  });

  test("rejects empty body via VALIDATION_ERROR", async () => {
    const store = new InMemoryContributionStore();
    const result = await sendMessageAsDiscussion(
      { agent: AGENT_ALICE, body: "   ", recipients: ["@bob"] },
      makeDeps(store),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(result.error.message).toMatch(/empty/);
  });

  test("rejects empty recipients via VALIDATION_ERROR", async () => {
    const store = new InMemoryContributionStore();
    const result = await sendMessageAsDiscussion(
      { agent: AGENT_ALICE, body: "Hi", recipients: [] },
      makeDeps(store),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(result.error.message).toMatch(/recipient/);
  });

  test("creates responds_to relation when inReplyTo is provided", async () => {
    const store = new InMemoryContributionStore();
    // First create a parent message so the responds_to target exists.
    const parent = await sendMessageAsDiscussion(
      { agent: AGENT_ALICE, body: "parent", recipients: ["@bob"] },
      makeDeps(store),
    );
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;

    const reply = await sendMessageAsDiscussion(
      {
        agent: AGENT_BOB,
        body: "reply",
        recipients: ["@alice"],
        inReplyTo: parent.value.cid,
      },
      makeDeps(store),
    );
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;

    const stored = await store.get(reply.value.cid);
    expect(stored?.relations).toHaveLength(1);
    expect(stored?.relations[0]?.relationType).toBe(RelationType.RespondsTo);
    expect(stored?.relations[0]?.targetCid).toBe(parent.value.cid);
  });

  test("rejects inReplyTo when target does not exist (validateRelations)", async () => {
    const store = new InMemoryContributionStore();
    const result = await sendMessageAsDiscussion(
      {
        agent: AGENT_ALICE,
        body: "orphan reply",
        recipients: ["@bob"],
        inReplyTo: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
      },
      makeDeps(store),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("multi-recipient message stores all addressees", async () => {
    const store = new InMemoryContributionStore();
    const result = await sendMessageAsDiscussion(
      {
        agent: AGENT_ALICE,
        body: "team broadcast",
        recipients: ["@bob", "@charlie", "@dave"],
      },
      makeDeps(store),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = await store.get(result.value.cid);
    expect(stored?.context?.recipients).toEqual(["@bob", "@charlie", "@dave"]);
  });

  test("idempotencyKey: identical retry returns cached result", async () => {
    const store = new InMemoryContributionStore();
    const input = {
      agent: AGENT_ALICE,
      body: "say once",
      recipients: ["@bob"],
      idempotencyKey: "broadcast-1",
    };
    const first = await sendMessageAsDiscussion(input, makeDeps(store));
    const second = await sendMessageAsDiscussion({ ...input }, makeDeps(store));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.cid).toBe(first.value.cid);
  });

  test("idempotencyKey: same key + different body is rejected with STATE_CONFLICT", async () => {
    const store = new InMemoryContributionStore();
    const first = await sendMessageAsDiscussion(
      {
        agent: AGENT_ALICE,
        body: "first body",
        recipients: ["@bob"],
        idempotencyKey: "broadcast-2",
      },
      makeDeps(store),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await sendMessageAsDiscussion(
      {
        agent: AGENT_ALICE,
        body: "different body",
        recipients: ["@bob"],
        idempotencyKey: "broadcast-2",
      },
      makeDeps(store),
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("STATE_CONFLICT");
  });

  // -------------------------------------------------------------------------
  // Regression test for #228: contract role-kind constraint must apply.
  // Before #228 fix: sendMessage bypassed PolicyEnforcer entirely so an
  // agent restricted to allowedKinds=["work"] could still send messages.
  // After #228 fix: sendMessageAsDiscussion routes through contributeOperation
  // and PolicyEnforcer rejects with role_kind violation.
  // -------------------------------------------------------------------------
  test("#228 regression: blocked when allowedKinds excludes 'discussion'", async () => {
    const rawStore = new InMemoryContributionStore();
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-contract",
      mode: ContributionMode.Evaluation,
      agentConstraints: { allowedKinds: ["work"] },
    };
    const store = new EnforcingContributionStore(rawStore, contract);

    const result = await sendMessageAsDiscussion(
      { agent: AGENT_ALICE, body: "should fail", recipients: ["@bob"] },
      makeDeps(store, contract),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // PolicyEnforcer throws PolicyViolationError which the operation
    // catches and converts to a result error.
    expect(result.error.code).toBeTruthy();
    // Make sure no contribution was actually written.
    const stored = await rawStore.list({ kind: ContributionKind.Discussion });
    expect(stored).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// readInbox
// ---------------------------------------------------------------------------

describe("readInbox", () => {
  /** Helper to seed the store with messages. */
  async function seedMessages(
    store: InMemoryContributionStore,
    messages: { from: typeof AGENT_ALICE; body: string; recipients: string[]; createdAt: string }[],
  ): Promise<Contribution[]> {
    const results: Contribution[] = [];
    for (const msg of messages) {
      const input: ContributionInput = {
        kind: ContributionKind.Discussion,
        mode: "exploration",
        summary: msg.body.slice(0, 120),
        description: msg.body,
        artifacts: {},
        relations: [],
        tags: ["message"],
        context: {
          ephemeral: true,
          recipients: msg.recipients,
          message_body: msg.body,
        },
        agent: msg.from,
        createdAt: msg.createdAt,
      };
      // Compute a deterministic-ish CID (just hash the input by length+chars)
      const raw = JSON.stringify(input);
      let hash = 0;
      for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) | 0;
      const hex = Math.abs(hash).toString(16).padStart(8, "0");
      const cid = `blake3:${hex.repeat(8)}`;
      const contribution: Contribution = { ...input, cid, manifestVersion: 1 };
      await store.put(contribution);
      results.push(contribution);
    }
    return results;
  }

  test("filters by recipient", async () => {
    const store = new InMemoryContributionStore();
    await seedMessages(store, [
      {
        from: AGENT_ALICE,
        body: "Hi Bob",
        recipients: ["@bob"],
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        from: AGENT_ALICE,
        body: "Hi Charlie",
        recipients: ["@charlie"],
        createdAt: "2026-01-01T01:00:00Z",
      },
    ]);

    const inbox = await readInbox(store, { recipient: "@bob" });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.body).toBe("Hi Bob");
  });

  test("filters by sender", async () => {
    const store = new InMemoryContributionStore();
    await seedMessages(store, [
      {
        from: AGENT_ALICE,
        body: "From Alice",
        recipients: ["@bob"],
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        from: AGENT_BOB,
        body: "From Bob",
        recipients: ["@bob"],
        createdAt: "2026-01-01T01:00:00Z",
      },
    ]);

    const inbox = await readInbox(store, { fromAgentId: "alice" });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.body).toBe("From Alice");
  });

  test("filters by since timestamp", async () => {
    const store = new InMemoryContributionStore();
    await seedMessages(store, [
      {
        from: AGENT_ALICE,
        body: "Old message",
        recipients: ["@bob"],
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        from: AGENT_ALICE,
        body: "New message",
        recipients: ["@bob"],
        createdAt: "2026-01-03T00:00:00Z",
      },
    ]);

    const inbox = await readInbox(store, { since: "2026-01-02T00:00:00Z" });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.body).toBe("New message");
  });

  test("returns messages sorted by most recent first", async () => {
    const store = new InMemoryContributionStore();
    await seedMessages(store, [
      { from: AGENT_ALICE, body: "First", recipients: ["@bob"], createdAt: "2026-01-01T00:00:00Z" },
      { from: AGENT_ALICE, body: "Third", recipients: ["@bob"], createdAt: "2026-01-03T00:00:00Z" },
      {
        from: AGENT_ALICE,
        body: "Second",
        recipients: ["@bob"],
        createdAt: "2026-01-02T00:00:00Z",
      },
    ]);

    const inbox = await readInbox(store);
    expect(inbox).toHaveLength(3);
    expect(inbox[0]?.body).toBe("Third");
    expect(inbox[1]?.body).toBe("Second");
    expect(inbox[2]?.body).toBe("First");
  });

  test("includes @all messages for any recipient", async () => {
    const store = new InMemoryContributionStore();
    await seedMessages(store, [
      {
        from: AGENT_ALICE,
        body: "Broadcast",
        recipients: ["@all"],
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        from: AGENT_BOB,
        body: "Direct to Charlie",
        recipients: ["@charlie"],
        createdAt: "2026-01-01T01:00:00Z",
      },
    ]);

    const inbox = await readInbox(store, { recipient: "@bob" });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.body).toBe("Broadcast");
  });

  test("multi-recipient query with OR semantics", async () => {
    const store = new InMemoryContributionStore();
    await seedMessages(store, [
      {
        from: AGENT_ALICE,
        body: "to-bob",
        recipients: ["@bob"],
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        from: AGENT_ALICE,
        body: "to-charlie",
        recipients: ["@charlie"],
        createdAt: "2026-01-01T01:00:00Z",
      },
      {
        from: AGENT_ALICE,
        body: "to-dave",
        recipients: ["@dave"],
        createdAt: "2026-01-01T02:00:00Z",
      },
    ]);
    const inbox = await readInbox(store, { recipients: ["@bob", "@charlie"] });
    expect(inbox).toHaveLength(2);
    const bodies = inbox.map((m) => m.body);
    expect(bodies).toContain("to-bob");
    expect(bodies).toContain("to-charlie");
    expect(bodies).not.toContain("to-dave");
  });

  test("empty inbox returns empty array", async () => {
    const store = new InMemoryContributionStore();
    const inbox = await readInbox(store, { recipient: "@bob" });
    expect(inbox).toEqual([]);
  });

  test("non-message discussions (no ephemeral flag) are excluded", async () => {
    const store = new InMemoryContributionStore();
    // Seed a regular discussion that is NOT a message — no ephemeral flag.
    const regular: ContributionInput = {
      kind: ContributionKind.Discussion,
      mode: "exploration",
      summary: "regular discussion",
      description: "regular discussion",
      artifacts: {},
      relations: [],
      tags: [],
      // Note: no ephemeral, no recipients, no message_body
      agent: AGENT_ALICE,
      createdAt: "2026-01-01T00:00:00Z",
    };
    const c: Contribution = { ...regular, cid: "blake3:reg".padEnd(72, "0"), manifestVersion: 1 };
    await store.put(c);

    // Also seed a real message
    await seedMessages(store, [
      {
        from: AGENT_BOB,
        body: "real msg",
        recipients: ["@bob"],
        createdAt: "2026-01-02T00:00:00Z",
      },
    ]);

    const inbox = await readInbox(store, { recipient: "@bob" });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.body).toBe("real msg");
  });

  test("limit caps the number of returned messages", async () => {
    const store = new InMemoryContributionStore();
    const seedData = Array.from({ length: 10 }, (_, i) => ({
      from: AGENT_ALICE,
      body: `msg-${i}`,
      recipients: ["@bob"],
      createdAt: `2026-01-01T${String(i).padStart(2, "0")}:00:00Z`,
    }));
    await seedMessages(store, seedData);
    const inbox = await readInbox(store, { recipient: "@bob", limit: 3 });
    expect(inbox).toHaveLength(3);
  });
});
