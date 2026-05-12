/**
 * T12 — Verify the operation-adapter wires `onEntityWrite` into the
 * WatchHub and that the contributions HTTP route injects the
 * per-request namespace into OperationDeps.
 *
 * Two layers of confidence:
 *   1. Direct: `toOperationDeps(deps)` returns a function that bumps
 *      `deps.watchHub.currentRv` when invoked. Proves the adapter wiring
 *      independent of any route.
 *   2. End-to-end: POSTing /api/contributions with the test auth header
 *      bumps the namespace+kind RV. Proves the namespace is being
 *      injected from `c.get("namespace")` and that contribute fires the
 *      hook with the right namespace.
 */

import { describe, expect, test } from "bun:test";
import { contributionToEntity } from "../core/entity.js";
import type { Contribution } from "../core/models.js";
import type { EntityWriteEvent } from "../core/watch-events.js";
import type { ServerDeps } from "./deps.js";
import { toOperationDeps } from "./operation-adapter.js";
import {
  createTestApp,
  makeManifestBody,
  TEST_AUTH_HEADERS,
  TEST_NAMESPACE,
} from "./test-helpers.js";

describe("watch wiring (T12)", () => {
  test("toOperationDeps forwards onEntityWrite into watchHub.recordWrite", () => {
    const { deps } = createTestApp();
    const opDeps = toOperationDeps(deps);

    expect(typeof opDeps.onEntityWrite).toBe("function");

    const before = deps.watchHub.currentRv("ns/wt", "Contribution");

    const fakeContribution: Contribution = {
      cid: `blake3:${"a".repeat(64)}`,
      manifestVersion: 1,
      kind: "work",
      mode: "evaluation",
      summary: "wiring-probe",
      artifacts: {},
      relations: [],
      tags: [],
      agent: { agentId: "probe", agentName: "probe", provider: "test", model: "test" },
      createdAt: new Date().toISOString(),
    };
    const event: EntityWriteEvent = {
      kind: "Contribution",
      namespace: "ns/wt",
      op: "ADDED",
      entity: contributionToEntity(fakeContribution, "ns/wt"),
    };

    if (opDeps.onEntityWrite === undefined) {
      throw new Error("onEntityWrite must be wired by toOperationDeps");
    }
    opDeps.onEntityWrite(event);

    const after = deps.watchHub.currentRv("ns/wt", "Contribution");
    expect(after).toBeGreaterThan(before);

    const creditsService = {
      close: () => undefined,
    } as unknown as NonNullable<ServerDeps["creditsService"]>;
    const bountyStore = {
      close: () => undefined,
    } as unknown as NonNullable<ServerDeps["bountyStore"]>;
    const opDepsWithCredits = toOperationDeps({ ...deps, creditsService, bountyStore });
    expect(opDepsWithCredits.creditsService).toBe(creditsService);
    expect(opDepsWithCredits.bountyStore).toBe(bountyStore);
  });

  test("HTTP contribute increments watchHub RV for the namespace", async () => {
    const { app, deps } = createTestApp();
    const before = deps.watchHub.currentRv(TEST_NAMESPACE, "Contribution");

    const res = await app.request("/api/contributions", {
      method: "POST",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(makeManifestBody({ summary: "T12 watch wiring test" })),
    });

    expect(res.status).toBe(201);

    const after = deps.watchHub.currentRv(TEST_NAMESPACE, "Contribution");
    expect(after).toBeGreaterThan(before);
  });
});
