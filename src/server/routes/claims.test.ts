import { describe, expect, test } from "bun:test";

import type { AgentIdentity, ClaimSpecRecord } from "../../core/models.js";
import { createTestApp, TEST_AUTH_HEADERS } from "../test-helpers.js";

const TEST_CONTROLLER_TOKEN = "test-controller-token";
const TEST_CONTROLLER_HEADERS: Record<string, string> = {
  "X-Grove-Controller-Token": TEST_CONTROLLER_TOKEN,
};

const TEST_AGENT: AgentIdentity = {
  agentId: "agent-claims-test",
  agentName: "Test Agent",
  provider: "test",
  model: "test-model",
};

function makeSpecBody(overrides?: Partial<ClaimSpecRecord>): Record<string, unknown> {
  return {
    targetRef: "task-claims-test",
    agent: { ...TEST_AGENT },
    intentSummary: "test claim",
    ...overrides,
  };
}

describe("PUT /api/claims/:id — @Dangerous + If-Match plumbing (C6 #304)", () => {
  test("missing If-Match → 428 and store.putClaimSpec not called", async () => {
    const { app, claimStore } = createTestApp();
    // Seed an existing spec so an update would otherwise hit CAS check.
    await claimStore.putClaimSpec({
      id: "claim-no-ifmatch",
      targetRef: "task",
      agent: TEST_AGENT,
      intentSummary: "seeded",
      generation: 0,
      createdAt: new Date().toISOString(),
    });
    const beforeRv = (await claimStore.getClaimView("claim-no-ifmatch"))?.spec.resourceVersion;

    const res = await app.request("/api/claims/claim-no-ifmatch", {
      method: "PUT",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(makeSpecBody({ intentSummary: "updated" })),
    });

    expect(res.status).toBe(428);
    // biome-ignore lint/suspicious/noExplicitAny: test file
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("PRECONDITION_REQUIRED");
    // Spec must remain unchanged — RV did not advance.
    const after = await claimStore.getClaimView("claim-no-ifmatch");
    expect(after?.spec.resourceVersion).toBe(beforeRv);
    expect(after?.spec.intentSummary).toBe("seeded");
  });

  test("stale If-Match → 409 with current snapshot", async () => {
    const { app, claimStore } = createTestApp();
    // Seed and then externally update so caller's "1" is stale.
    await claimStore.putClaimSpec({
      id: "claim-stale",
      targetRef: "task",
      agent: TEST_AGENT,
      intentSummary: "seeded",
      generation: 0,
      createdAt: new Date().toISOString(),
    });
    // External mutation: bump RV from 1 → 2.
    await claimStore.putClaimSpec(
      {
        id: "claim-stale",
        targetRef: "task",
        agent: TEST_AGENT,
        intentSummary: "rev2",
        generation: 0,
        createdAt: new Date().toISOString(),
      },
      { ifMatch: "1" },
    );
    expect((await claimStore.getClaimView("claim-stale"))?.spec.resourceVersion).toBe(2);

    const res = await app.request("/api/claims/claim-stale", {
      method: "PUT",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json", "if-match": "1" },
      body: JSON.stringify(makeSpecBody({ intentSummary: "rev3" })),
    });

    expect(res.status).toBe(409);
    // biome-ignore lint/suspicious/noExplicitAny: test file
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.current.resourceVersion).toBe("2");
    // Spec did not advance.
    expect((await claimStore.getClaimView("claim-stale"))?.spec.intentSummary).toBe("rev2");
  });

  test("fresh If-Match → 200 and store called with ifMatch", async () => {
    const { app, claimStore } = createTestApp();
    await claimStore.putClaimSpec({
      id: "claim-fresh",
      targetRef: "task",
      agent: TEST_AGENT,
      intentSummary: "seeded",
      generation: 0,
      createdAt: new Date().toISOString(),
    });

    const res = await app.request("/api/claims/claim-fresh", {
      method: "PUT",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json", "if-match": "1" },
      body: JSON.stringify(makeSpecBody({ intentSummary: "rev2" })),
    });

    expect(res.status).toBe(200);
    const view = await claimStore.getClaimView("claim-fresh");
    expect(view?.spec.resourceVersion).toBe(2);
    expect(view?.spec.intentSummary).toBe("rev2");
  });
});

describe("PATCH /api/claims/:id/status — @Dangerous + If-Match plumbing (C6 #304)", () => {
  test("missing If-Match → 428 and store.patchClaimStatus not called", async () => {
    const { app, claimStore } = createTestApp({ controllerToken: TEST_CONTROLLER_TOKEN });
    await claimStore.putClaimSpec({
      id: "claim-status-no-ifmatch",
      targetRef: "task",
      agent: TEST_AGENT,
      intentSummary: "seeded",
      generation: 0,
      createdAt: new Date().toISOString(),
    });
    const beforeRv = (await claimStore.getClaimView("claim-status-no-ifmatch"))?.status
      .resourceVersion;

    const res = await app.request("/api/claims/claim-status-no-ifmatch/status", {
      method: "PATCH",
      headers: {
        ...TEST_AUTH_HEADERS,
        ...TEST_CONTROLLER_HEADERS,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ phase: "released" }),
    });

    expect(res.status).toBe(428);
    // biome-ignore lint/suspicious/noExplicitAny: test file
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("PRECONDITION_REQUIRED");
    const after = await claimStore.getClaimView("claim-status-no-ifmatch");
    expect(after?.status.resourceVersion).toBe(beforeRv);
    expect(after?.status.phase).toBe("active");
  });

  test("stale If-Match → 409 with current snapshot", async () => {
    const { app, claimStore } = createTestApp({ controllerToken: TEST_CONTROLLER_TOKEN });
    await claimStore.putClaimSpec({
      id: "claim-status-stale",
      targetRef: "task",
      agent: TEST_AGENT,
      intentSummary: "seeded",
      generation: 0,
      createdAt: new Date().toISOString(),
    });
    // External status mutation bumps RV from 1 → 2.
    await claimStore.patchClaimStatus(
      "claim-status-stale",
      { agentSessionId: "session-x" },
      { ifMatch: "1" },
    );
    expect((await claimStore.getClaimView("claim-status-stale"))?.status.resourceVersion).toBe(2);

    const res = await app.request("/api/claims/claim-status-stale/status", {
      method: "PATCH",
      headers: {
        ...TEST_AUTH_HEADERS,
        ...TEST_CONTROLLER_HEADERS,
        "Content-Type": "application/json",
        "if-match": "1",
      },
      body: JSON.stringify({ phase: "released" }),
    });

    expect(res.status).toBe(409);
    // biome-ignore lint/suspicious/noExplicitAny: test file
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.current.resourceVersion).toBe("2");
    // Phase must not have transitioned.
    expect((await claimStore.getClaimView("claim-status-stale"))?.status.phase).toBe("active");
  });

  test("fresh If-Match → 200 and store called with ifMatch", async () => {
    const { app, claimStore } = createTestApp({ controllerToken: TEST_CONTROLLER_TOKEN });
    await claimStore.putClaimSpec({
      id: "claim-status-fresh",
      targetRef: "task",
      agent: TEST_AGENT,
      intentSummary: "seeded",
      generation: 0,
      createdAt: new Date().toISOString(),
    });

    const res = await app.request("/api/claims/claim-status-fresh/status", {
      method: "PATCH",
      headers: {
        ...TEST_AUTH_HEADERS,
        ...TEST_CONTROLLER_HEADERS,
        "Content-Type": "application/json",
        "if-match": "1",
      },
      body: JSON.stringify({ phase: "released" }),
    });

    expect(res.status).toBe(200);
    const view = await claimStore.getClaimView("claim-status-fresh");
    expect(view?.status.resourceVersion).toBe(2);
    expect(view?.status.phase).toBe("released");
  });
});
