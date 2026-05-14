import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { InMemoryTimelineStore } from "../../core/testing.js";
import { TimelineEventType, WorkBlockOrigin, WorkBlockStatus } from "../../core/timeline.js";
import type { EntityWriteEvent } from "../../core/watch-events.js";
import type { ServerDeps, ServerEnv } from "../deps.js";
import { createTestApp, TEST_AUTH_HEADERS, TEST_NAMESPACE } from "../test-helpers.js";
import { workBlocks } from "./work-blocks.js";

describe("work block routes", () => {
  test("creates and patches a work block with watch fan-out", async () => {
    const store = new InMemoryTimelineStore();
    const writes: EntityWriteEvent[] = [];
    const app = new Hono<ServerEnv>();
    app.use("*", async (c, next) => {
      c.set("namespace", "ns/test");
      c.set("deps", {
        timelineStore: store,
        watchHub: { recordWrite: (event: EntityWriteEvent) => writes.push(event) },
      } as unknown as ServerDeps);
      await next();
    });
    app.route("/", workBlocks);

    const create = await app.request("/work-blocks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeWorkBlock("wb_route", "s1")),
    });
    expect(create.status).toBe(201);

    const patch = await app.request("/work-blocks/wb_route", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: WorkBlockStatus.Running }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as WorkBlockResponse).status).toBe(WorkBlockStatus.Running);
    expect(writes.map((write) => write.op)).toEqual(["ADDED", "MODIFIED"]);
    expect(writes.every((write) => write.entity.kind === "WorkBlock")).toBe(true);
    const timelineEvents = await store.listTimelineEvents({ sessionId: "s1" });
    expect(timelineEvents.map((event) => event.type)).toEqual([
      TimelineEventType.WorkBlockCreated,
      TimelineEventType.WorkBlockStarted,
    ]);
  });

  test("lists WorkBlocks by session", async () => {
    const store = new InMemoryTimelineStore();
    await store.putWorkBlock(makeWorkBlock("wb_1", "s1"));
    await store.putWorkBlock(makeWorkBlock("wb_2", "s2"));
    const app = new Hono<ServerEnv>();
    app.use("*", async (c, next) => {
      c.set("namespace", "ns/test");
      c.set("deps", { timelineStore: store } as unknown as ServerDeps);
      await next();
    });
    app.route("/", workBlocks);

    const res = await app.request("/work-blocks?sessionId=s1");

    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as WorkBlockListResponse).items.map((block) => block.workBlockId),
    ).toEqual(["wb_1"]);
  });

  test("watch list endpoint exposes WorkBlock and TimelineEvent entities", async () => {
    const timelineStore = new InMemoryTimelineStore(TEST_NAMESPACE);
    await timelineStore.putWorkBlock(makeWorkBlock("wb_watch", "s1"));
    await timelineStore.appendTimelineEvent({
      eventId: "te_watch",
      sessionId: "s1",
      type: TimelineEventType.WorkBlockCreated,
      occurredAt: "2026-05-13T10:00:00.000Z",
      targetRefs: [{ kind: "WorkBlock", id: "wb_watch" }],
      payload: {},
    });
    const { app } = createTestApp({ timelineStore });

    const workBlocks = await app.request("/api/list?kind=WorkBlock", {
      headers: TEST_AUTH_HEADERS,
    });
    const events = await app.request("/api/list?kind=TimelineEvent", {
      headers: TEST_AUTH_HEADERS,
    });

    expect(workBlocks.status).toBe(200);
    expect(((await workBlocks.json()) as WatchListResponse).items).toMatchObject([
      { kind: "WorkBlock", namespace: TEST_NAMESPACE, id: "wb_watch" },
    ]);
    expect(events.status).toBe(200);
    expect(((await events.json()) as WatchListResponse).items).toMatchObject([
      { kind: "TimelineEvent", namespace: TEST_NAMESPACE, id: "te_watch" },
    ]);
  });

  test("watch notify treats TimelineEvent as append-only", async () => {
    const timelineStore = new InMemoryTimelineStore(TEST_NAMESPACE);
    await timelineStore.appendTimelineEvent({
      eventId: "te_notify",
      sessionId: "s1",
      type: TimelineEventType.WorkBlockCreated,
      occurredAt: "2026-05-13T10:00:00.000Z",
      targetRefs: [{ kind: "WorkBlock", id: "wb_watch" }],
      payload: {},
    });
    const { app } = createTestApp({ timelineStore });

    const added = await app.request("/api/watch/notify", {
      method: "POST",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "TimelineEvent", entityId: "te_notify" }),
    });
    const modified = await app.request("/api/watch/notify", {
      method: "POST",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "TimelineEvent", entityId: "te_notify", op: "MODIFIED" }),
    });
    const missing = await app.request("/api/watch/notify", {
      method: "POST",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "TimelineEvent", entityId: "te_missing" }),
    });

    expect(added.status).toBe(200);
    expect((await added.json()) as WatchNotifyResponse).toMatchObject({ ok: true, op: "ADDED" });
    expect(modified.status).toBe(400);
    expect(missing.status).toBe(404);
  });

  test("watch routes fail closed for timeline kinds without timeline store", async () => {
    const { app } = createTestApp({ timelineStore: null });

    const list = await app.request("/api/list?kind=TimelineEvent", {
      headers: TEST_AUTH_HEADERS,
    });
    const watch = await app.request("/api/watch?kind=WorkBlock&resumeFrom=0", {
      headers: TEST_AUTH_HEADERS,
    });
    const notify = await app.request("/api/watch/notify", {
      method: "POST",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "WorkBlock", entityId: "wb_missing" }),
    });

    expect(list.status).toBe(501);
    expect(watch.status).toBe(501);
    expect(notify.status).toBe(501);
  });
});

function makeWorkBlock(workBlockId: string, sessionId: string) {
  return {
    workBlockId,
    sessionId,
    goal: "Investigate incident",
    actor: { agentId: "agent-1" },
    origin: WorkBlockOrigin.Manual,
    status: WorkBlockStatus.Pending,
    updatedAt: "2026-05-13T10:00:00.000Z",
    inputRefs: [],
    outputRefs: [],
    evidenceRefs: [],
    approvalRefs: [],
    contributionCids: [],
    artifactHashes: [],
    claimIds: [],
    revision: 1,
    createdAt: "2026-05-13T10:00:00.000Z",
  };
}

interface WorkBlockResponse {
  readonly status: string;
}

interface WorkBlockListResponse {
  readonly items: readonly { readonly workBlockId: string }[];
}

interface WatchListResponse {
  readonly items: readonly {
    readonly kind: string;
    readonly namespace: string;
    readonly id: string;
  }[];
}

interface WatchNotifyResponse {
  readonly ok: boolean;
  readonly op: string;
}
