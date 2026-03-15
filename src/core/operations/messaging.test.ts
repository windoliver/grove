import { describe, expect, test } from "bun:test";

import type { Contribution, ContributionInput } from "../models.js";
import { ContributionKind, RelationType } from "../models.js";
import { InMemoryContributionStore } from "../testing.js";
import { readInbox, sendMessage } from "./messaging.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple deterministic CID mock for testing. */
function mockComputeCid(input: ContributionInput): string {
  const raw = JSON.stringify(input);
  // Use a simple hash-like hex string derived from content length + chars
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 31 + raw.charCodeAt(i)) | 0;
  }
  const hex = Math.abs(hash).toString(16).padStart(8, "0");
  return `blake3:${hex.repeat(8)}`;
}

const AGENT_ALICE = { agentId: "alice", agentName: "Alice" };
const AGENT_BOB = { agentId: "bob", agentName: "Bob" };

// ---------------------------------------------------------------------------
// sendMessage
// ---------------------------------------------------------------------------

describe("sendMessage", () => {
  test("creates ephemeral discussion contribution with recipients", async () => {
    const store = new InMemoryContributionStore();
    const result = await sendMessage(
      store,
      {
        agent: AGENT_ALICE,
        body: "Hello Bob!",
        recipients: ["@bob"],
      },
      mockComputeCid,
    );

    expect(result.kind).toBe(ContributionKind.Discussion);
    expect(result.context?.ephemeral).toBe(true);
    expect(result.context?.recipients).toEqual(["@bob"]);
    expect(result.context?.message_body).toBe("Hello Bob!");
    expect(result.tags).toContain("message");
    expect(result.manifestVersion).toBe(1);

    // Verify it was stored
    const stored = await store.get(result.cid);
    expect(stored).toBeDefined();
  });

  test("rejects empty body", async () => {
    const store = new InMemoryContributionStore();
    await expect(
      sendMessage(
        store,
        {
          agent: AGENT_ALICE,
          body: "   ",
          recipients: ["@bob"],
        },
        mockComputeCid,
      ),
    ).rejects.toThrow(/empty/);
  });

  test("rejects empty recipients", async () => {
    const store = new InMemoryContributionStore();
    await expect(
      sendMessage(
        store,
        {
          agent: AGENT_ALICE,
          body: "Hello!",
          recipients: [],
        },
        mockComputeCid,
      ),
    ).rejects.toThrow(/at least one recipient/);
  });

  test("creates responds_to relation when inReplyTo provided", async () => {
    const store = new InMemoryContributionStore();
    const parentCid = "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const result = await sendMessage(
      store,
      {
        agent: AGENT_ALICE,
        body: "Replying to your message",
        recipients: ["@bob"],
        inReplyTo: parentCid,
      },
      mockComputeCid,
    );

    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]?.relationType).toBe(RelationType.RespondsTo);
    expect(result.relations[0]?.targetCid).toBe(parentCid);
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
      // Build contribution directly to control createdAt
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
      const cid = mockComputeCid(input);
      const contribution: Contribution = {
        ...input,
        cid,
        manifestVersion: 1,
      };
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
});
