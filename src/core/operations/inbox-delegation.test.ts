import { describe, expect, test } from "bun:test";
import { DefaultFrontierCalculator } from "../frontier.js";
import type { ContributionStore } from "../store.js";
import { readInboxWithSource, sendMessageWithDelivery } from "./inbox-delegation.js";
import type { InboxMessage, InboxQuery, SendMessageInput } from "./messaging.js";
import { makeInMemoryContributionStore } from "./test-helpers.js";

const message: InboxMessage = {
  cid: "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  from: { agentId: "alice", agentName: "Alice" },
  body: "hello",
  recipients: ["@bob"],
  createdAt: "2026-05-12T12:00:00.000Z",
  tags: ["message"],
};

const sendInput: SendMessageInput = {
  agent: { agentId: "alice", agentName: "Alice" },
  body: "hello bob",
  recipients: ["@bob"],
};

function throwingStore(): ContributionStore {
  return {
    put: async () => undefined,
    putMany: async () => undefined,
    get: async () => undefined,
    getMany: async () => new Map(),
    list: async () => {
      throw new Error("store.list should not be called");
    },
    children: async () => [],
    ancestors: async () => [],
    relationsOf: async () => [],
    relatedTo: async () => [],
    search: async () => [],
    findExisting: async () => [],
    count: async () => 0,
    countSince: async () => 0,
    thread: async () => [],
    incomingSources: async () => [],
    replyCounts: async () => new Map(),
    hotThreads: async () => [],
    listEntities: async () => [],
    close: () => undefined,
  };
}

describe("readInboxWithSource", () => {
  test("recipient-filtered reads use the source without scanning the store", async () => {
    const calls: (InboxQuery | undefined)[] = [];
    const inbox = await readInboxWithSource(
      throwingStore(),
      { recipient: "@bob", limit: 5 },
      {
        readInbox: async (query) => {
          calls.push(query);
          return [message];
        },
      },
    );

    expect(inbox).toEqual([message]);
    expect(calls).toEqual([{ recipient: "@bob", limit: 5 }]);
  });

  test("unfiltered reads use the contribution store", async () => {
    let sourceCalled = false;
    let listCalled = false;
    const store = {
      ...throwingStore(),
      list: async () => {
        listCalled = true;
        return [];
      },
    };

    const inbox = await readInboxWithSource(
      store,
      { limit: 10 },
      {
        readInbox: async () => {
          sourceCalled = true;
          return [message];
        },
      },
    );

    expect(inbox).toEqual([]);
    expect(listCalled).toBe(true);
    expect(sourceCalled).toBe(false);
  });

  test("reads without a source use the contribution store", async () => {
    let listCalled = false;
    const store = {
      ...throwingStore(),
      list: async () => {
        listCalled = true;
        return [];
      },
    };

    const inbox = await readInboxWithSource(store, { limit: 10 });

    expect(inbox).toEqual([]);
    expect(listCalled).toBe(true);
  });

  test("source failure falls back to contribution-store readInbox", async () => {
    let listCalled = false;
    const store = {
      ...throwingStore(),
      list: async () => {
        listCalled = true;
        return [];
      },
    };

    const inbox = await readInboxWithSource(
      store,
      { recipient: "@bob" },
      {
        readInbox: async () => {
          throw new Error("Nexus inbox unavailable");
        },
      },
    );

    expect(inbox).toEqual([]);
    expect(listCalled).toBe(true);
  });
});

test("successful sends deliver a Grove message payload after contribution write", async () => {
  const contributionStore = makeInMemoryContributionStore();
  const delivered: unknown[] = [];

  const result = await sendMessageWithDelivery(
    sendInput,
    {
      contributionStore,
      frontier: new DefaultFrontierCalculator(contributionStore),
    },
    {
      deliverMessage: async (message) => {
        delivered.push(message);
      },
    },
  );

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("send unexpectedly failed");
  expect(delivered).toEqual([
    {
      cid: result.value.cid,
      body: "hello bob",
      recipients: ["@bob"],
      createdAt: result.value.createdAt,
      from: { agentId: "alice", agentName: "Alice" },
    },
  ]);
});

test("delivery failure does not fail the contribution write", async () => {
  const contributionStore = makeInMemoryContributionStore();

  const result = await sendMessageWithDelivery(
    sendInput,
    {
      contributionStore,
      frontier: new DefaultFrontierCalculator(contributionStore),
    },
    {
      deliverMessage: async () => {
        throw new Error("IPC failed");
      },
    },
  );

  expect(result.ok).toBe(true);
  expect((await contributionStore.list()).length).toBe(1);
});
