import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { HandoffStatus } from "../core/handoff.js";
import { InMemoryCreditsService } from "../core/in-memory-credits.js";
import { InMemoryHandoffStore } from "../core/in-memory-handoff-store.js";
import { guardMutableMethods, type ScopeMutationGuard } from "./scope-guard.js";

function activeHandoffStoreMutationMethodsFromHttpEntrypoint(): readonly string[] {
  const source = readFileSync(join(import.meta.dir, "serve-http.ts"), "utf-8");
  const start = source.indexOf(
    "activeHandoffStore = guardMutableMethods(activeHandoffStore, mutationGuard, [",
  );
  if (start < 0) throw new Error("activeHandoffStore guard list not found");
  const end = source.indexOf("]);", start);
  if (end < 0) throw new Error("activeHandoffStore guard list end not found");
  return Array.from(source.slice(start, end).matchAll(/"([^"]+)"/g), (match) => {
    const method = match[1];
    if (method === undefined) throw new Error("missing method match");
    return method;
  });
}

describe("scope mutation guard", () => {
  test("guarded credits service refuses reserve after deactivation without creating reservation", async () => {
    const creditsService = new InMemoryCreditsService();
    creditsService.seed("agent-1", 100);

    let active = true;
    const guard: ScopeMutationGuard = {
      deactivate() {
        active = false;
      },
      assertMutable(operation) {
        if (!active) {
          throw new Error(`scope inactive for ${operation}`);
        }
      },
    };

    const scopedCreditsService = guardMutableMethods(creditsService, guard, [
      "reserve",
      "capture",
      "void",
      "transfer",
    ]);

    guard.deactivate();

    expect(() =>
      scopedCreditsService.reserve({
        reservationId: "stale-scope-reservation",
        agentId: "agent-1",
        amount: 25,
        timeoutMs: 60_000,
      }),
    ).toThrow("scope inactive for reserve");

    expect(await scopedCreditsService.balance("agent-1")).toEqual({
      available: 100,
      reserved: 0,
      total: 100,
    });
  });

  test("HTTP handoff stale-scope guard blocks operator terminal mutations", async () => {
    const handoffStore = new InMemoryHandoffStore();
    const cancelled = await handoffStore.create({
      sourceCid: "blake3:cancel",
      fromRole: "planner",
      toRole: "reviewer",
    });
    const manuallyResolved = await handoffStore.create({
      sourceCid: "blake3:resolve",
      fromRole: "planner",
      toRole: "reviewer",
    });

    let active = true;
    const guard: ScopeMutationGuard = {
      deactivate() {
        active = false;
      },
      assertMutable(operation) {
        if (!active) {
          throw new Error(`scope inactive for ${operation}`);
        }
      },
    };

    const scopedHandoffStore = guardMutableMethods(
      handoffStore,
      guard,
      activeHandoffStoreMutationMethodsFromHttpEntrypoint(),
    );

    guard.deactivate();

    expect(() => scopedHandoffStore.markCancelled(cancelled.handoffId)).toThrow(
      "scope inactive for markCancelled",
    );
    expect(() => scopedHandoffStore.markManuallyResolved(manuallyResolved.handoffId)).toThrow(
      "scope inactive for markManuallyResolved",
    );

    expect((await handoffStore.get(cancelled.handoffId))?.status).toBe(HandoffStatus.PendingPickup);
    expect((await handoffStore.get(manuallyResolved.handoffId))?.status).toBe(
      HandoffStatus.PendingPickup,
    );
  });
});
