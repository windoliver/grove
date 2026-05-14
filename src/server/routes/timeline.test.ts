import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { InMemoryTimelineStore } from "../../core/testing.js";
import { TimelineEventType, WorkBlockOrigin, WorkBlockStatus } from "../../core/timeline.js";
import type { ServerDeps, ServerEnv } from "../deps.js";
import { timeline } from "./timeline.js";

describe("timeline routes", () => {
  test("GET /timeline returns ordered events and current RV", async () => {
    const store = new InMemoryTimelineStore();
    await store.appendTimelineEvent({
      eventId: "te_1",
      sessionId: "s1",
      type: TimelineEventType.WorkBlockCreated,
      occurredAt: "2026-05-13T10:00:00.000Z",
      targetRefs: [{ kind: "WorkBlock", id: "wb_1" }],
      payload: {},
    });
    await store.appendTimelineEvent({
      eventId: "te_2",
      sessionId: "s1",
      type: TimelineEventType.WorkBlockStarted,
      occurredAt: "2026-05-13T10:01:00.000Z",
      targetRefs: [{ kind: "WorkBlock", id: "wb_1" }],
      payload: {},
    });

    const app = routeApp(store);
    const res = await app.request("/timeline?sessionId=s1");

    expect(res.status).toBe(200);
    const json = (await res.json()) as TimelineRouteResponse;
    expect(json.timelineResourceVersion).toBe("2");
    expect(json.events.map((event: { eventId: string }) => event.eventId)).toEqual([
      "te_1",
      "te_2",
    ]);
  });

  test("GET /timeline can include WorkBlocks for the session", async () => {
    const store = new InMemoryTimelineStore();
    await store.putWorkBlock(makeWorkBlock("wb_1", "s1"));
    await store.putWorkBlock(makeWorkBlock("wb_2", "s2"));

    const app = routeApp(store);
    const res = await app.request("/timeline?sessionId=s1&includeWorkBlocks=true");

    expect(res.status).toBe(200);
    const json = (await res.json()) as TimelineRouteResponse;
    expect(json.workBlocks?.map((block: { workBlockId: string }) => block.workBlockId)).toEqual([
      "wb_1",
    ]);
  });

  test("GET /timeline/events/:eventId returns one event", async () => {
    const store = new InMemoryTimelineStore();
    await store.appendTimelineEvent({
      eventId: "te_lookup",
      sessionId: "s1",
      type: TimelineEventType.WorkBlockCreated,
      occurredAt: "2026-05-13T10:00:00.000Z",
      targetRefs: [{ kind: "WorkBlock", id: "wb_lookup" }],
      payload: {},
    });

    const app = routeApp(store);
    const res = await app.request("/timeline/events/te_lookup");

    expect(res.status).toBe(200);
    expect(((await res.json()) as TimelineEventResponse).eventId).toBe("te_lookup");
  });
});

function routeApp(store: InMemoryTimelineStore): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();
  app.use("*", async (c, next) => {
    c.set("namespace", "ns/test");
    c.set("deps", { timelineStore: store } as unknown as ServerDeps);
    await next();
  });
  app.route("/", timeline);
  return app;
}

interface TimelineRouteResponse {
  readonly timelineResourceVersion: string;
  readonly events: readonly { readonly eventId: string }[];
  readonly workBlocks?: readonly { readonly workBlockId: string }[] | undefined;
}

interface TimelineEventResponse {
  readonly eventId: string;
}

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
