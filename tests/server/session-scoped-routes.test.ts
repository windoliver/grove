import { describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { DefaultFrontierCalculator } from "../../src/core/frontier.js";
import type { Contribution } from "../../src/core/models.js";
import { ContributionKind, ContributionMode, RelationType } from "../../src/core/models.js";
import { InMemoryContributionStore } from "../../src/core/testing.js";
import { createApp } from "../../src/server/app.js";
import type { ServerEnv } from "../../src/server/deps.js";
import {
  InMemoryClaimStore,
  InMemoryContentStore,
  TEST_NAMESPACE,
  TEST_NAMESPACE_KEY,
} from "../../src/server/test-helpers.js";

const SESSION_ID = "session-1";
const TEST_AUTH_HEADERS = { Authorization: `Bearer ${TEST_NAMESPACE_KEY}` };
const ROOT_CID = `blake3:${"1".repeat(64)}`;
const CHILD_CID = `blake3:${"2".repeat(64)}`;

function makeContribution(overrides?: Partial<Contribution>): Contribution {
  return {
    manifestVersion: 1,
    cid: ROOT_CID,
    kind: ContributionKind.Work,
    mode: ContributionMode.Evaluation,
    summary: "Session scoped needle",
    artifacts: {},
    relations: [],
    tags: ["session"],
    agent: { agentId: "agent-1" },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeAppWithScopedStore(contributions: readonly Contribution[]): {
  readonly app: Hono<ServerEnv>;
  readonly scopedStore: InMemoryContributionStore;
  readonly cas: InMemoryContentStore;
} {
  const globalStore = new InMemoryContributionStore();
  const scopedStore = new InMemoryContributionStore(contributions);
  const cas = new InMemoryContentStore();
  const deps = {
    contributionStore: globalStore,
    contributionStoreForSession: (sessionId: string) =>
      sessionId === SESSION_ID ? scopedStore : globalStore,
    claimStore: new InMemoryClaimStore(),
    cas,
    frontier: new DefaultFrontierCalculator(globalStore),
  };
  const registry = new Map([[TEST_NAMESPACE_KEY, TEST_NAMESPACE]]);
  return { app: createApp(deps, registry), scopedStore, cas };
}

describe("session-scoped server routes", () => {
  test("GET /api/contributions/:cid reads from the session-scoped store", async () => {
    const contribution = makeContribution();
    const { app } = makeAppWithScopedStore([contribution]);

    const res = await app.request(
      `/api/contributions/${contribution.cid}?sessionId=${SESSION_ID}`,
      {
        headers: TEST_AUTH_HEADERS,
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { cid: string; summary: string };
    expect(body.cid).toBe(contribution.cid);
    expect(body.summary).toBe("Session scoped needle");
  });

  test("GET /api/contributions/:cid/artifacts/:name reads metadata from the scoped store", async () => {
    const { app, scopedStore, cas } = makeAppWithScopedStore([]);
    const hash = await cas.put(new TextEncoder().encode("artifact body"), {
      mediaType: "text/plain",
    });
    const contribution = makeContribution({ artifacts: { "note.txt": hash } });
    await scopedStore.put(contribution);

    const res = await app.request(
      `/api/contributions/${contribution.cid}/artifacts/note.txt/meta?sessionId=${SESSION_ID}`,
      { headers: TEST_AUTH_HEADERS },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sizeBytes: number; mediaType?: string };
    expect(body.sizeBytes).toBe("artifact body".length);
    expect(body.mediaType).toBe("text/plain");
  });

  test("GET /api/frontier uses the session-scoped contribution store", async () => {
    const contribution = makeContribution();
    const { app } = makeAppWithScopedStore([contribution]);

    const res = await app.request(`/api/frontier?sessionId=${SESSION_ID}`, {
      headers: TEST_AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { byRecency: readonly { cid: string }[] };
    expect(body.byRecency.map((entry) => entry.cid)).toEqual([contribution.cid]);
  });

  test("GET /api/search uses the session-scoped contribution store", async () => {
    const contribution = makeContribution();
    const { app } = makeAppWithScopedStore([contribution]);

    const res = await app.request(`/api/search?q=needle&sessionId=${SESSION_ID}`, {
      headers: TEST_AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: readonly { cid: string }[] };
    expect(body.results.map((entry) => entry.cid)).toEqual([contribution.cid]);
  });

  test("GET /api/dag/:cid/children uses the session-scoped contribution store", async () => {
    const root = makeContribution();
    const child = makeContribution({
      cid: CHILD_CID,
      summary: "Child contribution",
      relations: [{ targetCid: root.cid, relationType: RelationType.DerivesFrom }],
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const { app } = makeAppWithScopedStore([root, child]);

    const res = await app.request(`/api/dag/${root.cid}/children?sessionId=${SESSION_ID}`, {
      headers: TEST_AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as readonly { cid: string }[];
    expect(body.map((entry) => entry.cid)).toEqual([child.cid]);
  });

  test("GET /api/threads/:cid uses the session-scoped contribution store", async () => {
    const root = makeContribution({ kind: ContributionKind.Discussion });
    const reply = makeContribution({
      cid: CHILD_CID,
      kind: ContributionKind.Discussion,
      summary: "Reply contribution",
      relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const { app } = makeAppWithScopedStore([root, reply]);

    const res = await app.request(`/api/threads/${root.cid}?sessionId=${SESSION_ID}`, {
      headers: TEST_AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodes: readonly { cid: string }[] };
    expect(body.nodes.map((entry) => entry.cid)).toEqual([root.cid, reply.cid]);
  });

  test("GET /api/boardroom/summary uses the session-scoped contribution store", async () => {
    const message = makeContribution({
      kind: ContributionKind.Discussion,
      mode: ContributionMode.Exploration,
      summary: "Operator message",
      context: {
        ephemeral: true,
        recipients: ["@all"],
        message_body: "Visible in scoped boardroom",
      },
    });
    const { app } = makeAppWithScopedStore([message]);

    const res = await app.request(`/api/boardroom/summary?sessionId=${SESSION_ID}`, {
      headers: TEST_AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      recentMessages: readonly {
        cid: string;
        fromAgentId: string;
        body: string;
        recipients: readonly string[];
        createdAt: string;
      }[];
    };
    expect(body.recentMessages).toEqual([
      {
        cid: message.cid,
        fromAgentId: "agent-1",
        body: "Visible in scoped boardroom",
        recipients: ["@all"],
        createdAt: message.createdAt,
      },
    ]);
  });
});
