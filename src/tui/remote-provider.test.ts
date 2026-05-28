/**
 * Tests for the remote TUI data provider.
 *
 * Spins up an in-process Hono server via Bun.serve and runs
 * the conformance suite against RemoteDataProvider.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { computeCid } from "../core/manifest.js";
import type { ContributionInput } from "../core/models.js";
import { TimelineEventType, WorkBlockOrigin, WorkBlockStatus } from "../core/timeline.js";
import { createTestApp, TEST_NAMESPACE_KEY } from "../server/test-helpers.js";
import { runProviderConformanceTests } from "./provider.conformance.js";
import type { TuiHandoffProvider } from "./provider.js";
import { RemoteDataProvider } from "./remote-provider.js";

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function makeContribution(
  overrides: Partial<ContributionInput> = {},
): ContributionInput & { cid: string } {
  const input: ContributionInput = {
    kind: "work",
    mode: "evaluation",
    summary: overrides.summary ?? "Test contribution",
    artifacts: {},
    relations: overrides.relations ?? [],
    tags: overrides.tags ?? ["test"],
    agent: overrides.agent ?? { agentId: "agent-1", agentName: "Alice" },
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    scores: overrides.scores,
    context: overrides.context,
    ...overrides,
  };
  const cid = computeCid(input);
  return { cid, ...input };
}

function makeWorkBlock(workBlockId: string, sessionId: string) {
  return {
    workBlockId,
    sessionId,
    goal: "Investigate remote provider timeline",
    actor: { agentId: "agent-1" },
    origin: WorkBlockOrigin.Agent,
    status: WorkBlockStatus.Running,
    startedAt: "2026-05-13T10:00:00.000Z",
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

// ---------------------------------------------------------------------------
// Factory for conformance suite
// ---------------------------------------------------------------------------

async function createTestProvider(): Promise<{
  provider: RemoteDataProvider;
  testCid: string;
  cleanup: () => void;
}> {
  const ctx = createTestApp();

  const c1 = makeContribution({ summary: "Initial work" });
  const c2 = makeContribution({
    summary: "Follow-up work",
    relations: [{ targetCid: c1.cid, relationType: "derives_from" }],
    createdAt: new Date(Date.now() + 1000).toISOString(),
  });
  const c3 = makeContribution({
    kind: "review",
    summary: "Review of initial work",
    relations: [{ targetCid: c1.cid, relationType: "reviews" }],
    createdAt: new Date(Date.now() + 2000).toISOString(),
  });

  // Seed contributions via the store directly
  ctx.contributionStore.put({ manifestVersion: 1, ...c1 });
  ctx.contributionStore.put({ manifestVersion: 1, ...c2 });
  ctx.contributionStore.put({ manifestVersion: 1, ...c3 });

  // Seed a claim
  await ctx.claimStore.createClaim({
    claimId: `claim-${Date.now()}`,
    targetRef: c1.cid,
    agent: { agentId: "agent-1", agentName: "Alice" },
    status: "active",
    intentSummary: "Working on it",
    createdAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  });
  if (ctx.timelineStore === undefined) throw new Error("Expected timeline store");
  await ctx.timelineStore.putWorkBlock(makeWorkBlock("wb_remote_provider", "session-provider"));
  await ctx.timelineStore.appendTimelineEvent({
    eventId: "te_remote_provider",
    sessionId: "session-provider",
    type: TimelineEventType.WorkBlockStarted,
    occurredAt: "2026-05-13T10:00:00.000Z",
    targetRefs: [{ kind: "WorkBlock", id: "wb_remote_provider" }],
    payload: {},
  });

  // Start an ephemeral server
  const server = Bun.serve({
    port: 0,
    fetch: ctx.app.fetch,
  });

  const provider = new RemoteDataProvider(`http://localhost:${server.port}`, {
    apiKey: TEST_NAMESPACE_KEY,
  });

  return {
    provider,
    testCid: c1.cid,
    cleanup: () => {
      server.stop(true);
    },
  };
}

// Run the conformance suite
runProviderConformanceTests("RemoteDataProvider", createTestProvider);

// ---------------------------------------------------------------------------
// Additional remote-specific tests
// ---------------------------------------------------------------------------

describe("RemoteDataProvider specific", () => {
  let provider: RemoteDataProvider;
  let cleanup: () => void;

  beforeAll(async () => {
    const result = await createTestProvider();
    provider = result.provider;
    cleanup = result.cleanup;
  });

  afterAll(() => cleanup());

  test("getDashboard includes backendLabel", async () => {
    const dashboard = await provider.getDashboard();
    expect(dashboard.metadata.backendLabel).toBeDefined();
    expect(typeof dashboard.metadata.backendLabel).toBe("string");
  });

  test("getContribution returns undefined for non-existent CID", async () => {
    const detail = await provider.getContribution(
      "blake3:0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(detail).toBeUndefined();
  });

  test("exposes WorkBlocks and SessionTimeline from remote timeline routes", async () => {
    const blocks = await provider.getWorkBlocks?.({ sessionId: "session-provider" });
    const timeline = await provider.getTimeline?.({
      sessionId: "session-provider",
      includeWorkBlocks: true,
    });

    expect(blocks?.map((block) => block.workBlockId)).toEqual(["wb_remote_provider"]);
    expect(timeline?.events.map((event) => event.eventId)).toEqual(["te_remote_provider"]);
    expect(timeline?.workBlocks?.map((block) => block.workBlockId)).toEqual(["wb_remote_provider"]);
  });

  test("applies active session scope to detail, graph, artifact, and search reads", async () => {
    const contribution = { manifestVersion: 1, ...makeContribution({ summary: "Scoped parser" }) };
    const requestedPaths: string[] = [];
    const encoder = new TextEncoder();
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      });

    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        requestedPaths.push(`${url.pathname}${url.search}`);

        if (url.pathname.endsWith("/artifacts/note.txt/meta")) {
          return json({ sizeBytes: 8, mediaType: "text/plain" });
        }
        if (url.pathname.endsWith("/artifacts/note.txt")) {
          return new Response(encoder.encode("artifact"), {
            headers: { "Content-Type": "text/plain" },
          });
        }
        if (url.pathname.startsWith("/api/dag/")) {
          return json([]);
        }
        if (url.pathname.startsWith("/api/threads/")) {
          return json({ nodes: [], count: 0 });
        }
        if (url.pathname === "/api/search") {
          return json({ results: [contribution], count: 1 });
        }
        if (url.pathname.startsWith("/api/contributions/")) {
          return json(contribution);
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const scopedProvider = new RemoteDataProvider(`http://localhost:${server.port}`);
      scopedProvider.setSessionScope("session-1");

      await scopedProvider.getContribution(contribution.cid);
      await scopedProvider.getDag(contribution.cid);
      await scopedProvider.getArtifact(contribution.cid, "note.txt");
      await scopedProvider.getArtifactMeta(contribution.cid, "note.txt");
      await scopedProvider.search("parser");
    } finally {
      server.stop(true);
    }

    expect(requestedPaths.length).toBeGreaterThan(0);
    expect(requestedPaths.every((path) => path.includes("sessionId=session-1"))).toBe(true);
  });

  test("posts handoff operator actions with JSON body, auth, and session scope", async () => {
    interface CapturedRequest {
      readonly method: string;
      readonly path: string;
      readonly authorization: string | null;
      readonly contentType: string | null;
      readonly body: unknown;
    }

    const requests: CapturedRequest[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        requests.push({
          method: req.method,
          path: `${url.pathname}${url.search}`,
          authorization: req.headers.get("authorization"),
          contentType: req.headers.get("content-type"),
          body: await req.json(),
        });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    try {
      const scopedProvider = new RemoteDataProvider(`http://localhost:${server.port}`, {
        apiKey: "secret-token",
      });
      scopedProvider.setSessionScope("active-session");
      const handoffs = scopedProvider as unknown as TuiHandoffProvider;

      await handoffs.cancelHandoff("handoff/1", "wrong target", "explicit-session");
      await handoffs.manualResolveHandoff("handoff 2", "handled manually");
      await handoffs.resendHandoff("handoff:3", {
        reason: "retry delivery",
        replyDueAt: "2026-05-20T10:00:00.000Z",
        sessionId: "resend-session",
      });
      await handoffs.rerouteHandoff("handoff?4", {
        toRole: "reviewer",
        reason: "needs review",
        replyDueAt: "2026-05-20T11:00:00.000Z",
      });
    } finally {
      server.stop(true);
    }

    expect(requests).toEqual([
      {
        method: "POST",
        path: "/api/handoffs/handoff%2F1/cancel?sessionId=explicit-session",
        authorization: "Bearer secret-token",
        contentType: "application/json",
        body: { reason: "wrong target" },
      },
      {
        method: "POST",
        path: "/api/handoffs/handoff%202/manual-resolve?sessionId=active-session",
        authorization: "Bearer secret-token",
        contentType: "application/json",
        body: { reason: "handled manually" },
      },
      {
        method: "POST",
        path: "/api/handoffs/handoff%3A3/resend?sessionId=resend-session",
        authorization: "Bearer secret-token",
        contentType: "application/json",
        body: {
          reason: "retry delivery",
          replyDueAt: "2026-05-20T10:00:00.000Z",
        },
      },
      {
        method: "POST",
        path: "/api/handoffs/handoff%3F4/reroute?sessionId=active-session",
        authorization: "Bearer secret-token",
        contentType: "application/json",
        body: {
          toRole: "reviewer",
          reason: "needs review",
          replyDueAt: "2026-05-20T11:00:00.000Z",
        },
      },
    ]);
  });

  test("getSessionContributions uses the dedicated session history route", async () => {
    const requestedPaths: string[] = [];
    const contribution = { manifestVersion: 1, ...makeContribution({ summary: "history item" }) };
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        requestedPaths.push(`${url.pathname}${url.search}`);
        if (url.pathname === "/api/sessions/session-1/contributions") {
          return Response.json([contribution]);
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const provider = new RemoteDataProvider(`http://localhost:${server.port}`);
      const result = await provider.getSessionContributions("session-1");

      expect(result.map((c) => c.cid)).toEqual([contribution.cid]);
    } finally {
      server.stop(true);
    }

    expect(requestedPaths).toEqual(["/api/sessions/session-1/contributions"]);
  });
});
