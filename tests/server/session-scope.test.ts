import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultFrontierCalculator } from "../../src/core/frontier.js";
import { createContribution } from "../../src/core/manifest.js";
import type { Contribution, ContributionInput } from "../../src/core/models.js";
import { InMemoryContributionStore } from "../../src/core/testing.js";
import { WatchHub } from "../../src/core/watch-hub.js";
import { createSqliteStores } from "../../src/local/sqlite-store.js";
import { createApp } from "../../src/server/app.js";
import type { ServerDeps } from "../../src/server/deps.js";
import {
  InMemoryClaimStore,
  InMemoryContentStore,
  TEST_AUTH_HEADERS,
  TEST_NAMESPACE,
  TEST_NAMESPACE_KEY,
} from "../../src/server/test-helpers.js";

const TEST_REGISTRY = new Map([[TEST_NAMESPACE_KEY, TEST_NAMESPACE]]);

function makeContribution(overrides: Partial<ContributionInput> = {}): Contribution {
  return createContribution({
    kind: "work",
    mode: "evaluation",
    summary: "Session contribution",
    artifacts: {},
    relations: [],
    tags: ["session"],
    agent: { agentId: "agent-session" },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function makeDeps(
  globalStore: InMemoryContributionStore,
  scopedStore: InMemoryContributionStore,
  cas: InMemoryContentStore,
): ServerDeps {
  return {
    contributionStore: globalStore,
    contributionStoreForSession: (sessionId) =>
      sessionId === "session-a" ? scopedStore : globalStore,
    claimStore: new InMemoryClaimStore(),
    cas,
    frontier: new DefaultFrontierCalculator(globalStore),
    frontierForSession: (sessionId) =>
      new DefaultFrontierCalculator(sessionId === "session-a" ? scopedStore : globalStore),
    watchHub: new WatchHub(),
  };
}

describe("server session-scoped contribution reads", () => {
  test("frontier uses the session-scoped contribution store", async () => {
    const globalStore = new InMemoryContributionStore();
    const scopedStore = new InMemoryContributionStore([
      makeContribution({ summary: "Scoped frontier item" }),
    ]);
    const app = createApp(
      makeDeps(globalStore, scopedStore, new InMemoryContentStore()),
      TEST_REGISTRY,
    );

    const res = await app.request("/api/frontier?sessionId=session-a", {
      headers: TEST_AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { byRecency: readonly { summary: string }[] };
    expect(body.byRecency.map((entry) => entry.summary)).toEqual(["Scoped frontier item"]);
  });

  test("detail, dag, thread, and artifact routes use the session-scoped store", async () => {
    const globalStore = new InMemoryContributionStore();
    const scopedStore = new InMemoryContributionStore();
    const cas = new InMemoryContentStore();
    const artifactHash = await cas.put(new TextEncoder().encode("scoped artifact"));
    const root = makeContribution({
      summary: "Scoped root",
      artifacts: { "notes.txt": artifactHash },
    });
    const child = makeContribution({
      summary: "Scoped reply",
      relations: [{ targetCid: root.cid, relationType: "responds_to" }],
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await scopedStore.putMany([root, child]);
    const app = createApp(makeDeps(globalStore, scopedStore, cas), TEST_REGISTRY);

    const detail = await app.request(`/api/contributions/${root.cid}?sessionId=session-a`, {
      headers: TEST_AUTH_HEADERS,
    });
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as Contribution).summary).toBe("Scoped root");

    const children = await app.request(`/api/dag/${root.cid}/children?sessionId=session-a`, {
      headers: TEST_AUTH_HEADERS,
    });
    expect(children.status).toBe(200);
    expect(((await children.json()) as readonly Contribution[]).map((c) => c.cid)).toEqual([
      child.cid,
    ]);

    const thread = await app.request(`/api/threads/${root.cid}?sessionId=session-a`, {
      headers: TEST_AUTH_HEADERS,
    });
    expect(thread.status).toBe(200);
    const threadBody = (await thread.json()) as { nodes: readonly { cid: string }[] };
    expect(threadBody.nodes.map((node) => node.cid)).toEqual([root.cid, child.cid]);

    const artifact = await app.request(
      `/api/contributions/${root.cid}/artifacts/notes.txt?sessionId=session-a`,
      { headers: TEST_AUTH_HEADERS },
    );
    expect(artifact.status).toBe(200);
    expect(await artifact.text()).toBe("scoped artifact");
  });

  test("local fallback keeps detail, DAG, thread, and artifact reads session-scoped", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "grove-session-scope-local-"));
    const stores = createSqliteStores(join(tempDir, "grove.db"));
    try {
      const sessionA = await stores.goalSessionStore.createSession({ goal: "session A" });
      const sessionB = await stores.goalSessionStore.createSession({ goal: "session B" });
      const cas = new InMemoryContentStore();
      const artifactHash = await cas.put(new TextEncoder().encode("session-a artifact"));
      const root = makeContribution({
        summary: "Local scoped root",
        artifacts: { "notes.txt": artifactHash },
      });
      const sessionChild = makeContribution({
        summary: "Local scoped child",
        relations: [{ targetCid: root.cid, relationType: "responds_to" }],
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      const otherSessionChild = makeContribution({
        summary: "Other session child",
        relations: [{ targetCid: root.cid, relationType: "responds_to" }],
        createdAt: "2026-01-01T00:00:02.000Z",
      });
      await stores.contributionStore.putMany([root, sessionChild, otherSessionChild]);
      await stores.goalSessionStore.addContributionToSession(sessionA.id, root.cid);
      await stores.goalSessionStore.addContributionToSession(sessionA.id, sessionChild.cid);
      await stores.goalSessionStore.addContributionToSession(sessionB.id, otherSessionChild.cid);

      const app = createApp(
        {
          contributionStore: stores.contributionStore,
          claimStore: stores.claimStore,
          cas,
          frontier: new DefaultFrontierCalculator(stores.contributionStore),
          watchHub: new WatchHub(),
        },
        TEST_REGISTRY,
      );

      const detailA = await app.request(`/api/contributions/${root.cid}?sessionId=${sessionA.id}`, {
        headers: TEST_AUTH_HEADERS,
      });
      expect(detailA.status).toBe(200);

      const detailB = await app.request(`/api/contributions/${root.cid}?sessionId=${sessionB.id}`, {
        headers: TEST_AUTH_HEADERS,
      });
      expect(detailB.status).toBe(404);

      const children = await app.request(`/api/dag/${root.cid}/children?sessionId=${sessionA.id}`, {
        headers: TEST_AUTH_HEADERS,
      });
      expect(children.status).toBe(200);
      expect(((await children.json()) as readonly Contribution[]).map((c) => c.cid)).toEqual([
        sessionChild.cid,
      ]);

      const thread = await app.request(`/api/threads/${root.cid}?sessionId=${sessionA.id}`, {
        headers: TEST_AUTH_HEADERS,
      });
      expect(thread.status).toBe(200);
      const threadBody = (await thread.json()) as { nodes: readonly { cid: string }[] };
      expect(threadBody.nodes.map((node) => node.cid)).toEqual([root.cid, sessionChild.cid]);

      const hotThreads = await app.request(`/api/threads?sessionId=${sessionA.id}`, {
        headers: TEST_AUTH_HEADERS,
      });
      expect(hotThreads.status).toBe(200);
      const hotThreadsBody = (await hotThreads.json()) as {
        threads: readonly { cid: string; replyCount: number }[];
      };
      expect(hotThreadsBody.threads.map((t) => ({ cid: t.cid, replyCount: t.replyCount }))).toEqual(
        [{ cid: root.cid, replyCount: 1 }],
      );

      const artifactA = await app.request(
        `/api/contributions/${root.cid}/artifacts/notes.txt?sessionId=${sessionA.id}`,
        { headers: TEST_AUTH_HEADERS },
      );
      expect(artifactA.status).toBe(200);
      expect(await artifactA.text()).toBe("session-a artifact");

      const artifactB = await app.request(
        `/api/contributions/${root.cid}/artifacts/notes.txt?sessionId=${sessionB.id}`,
        { headers: TEST_AUTH_HEADERS },
      );
      expect(artifactB.status).toBe(404);
    } finally {
      stores.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
