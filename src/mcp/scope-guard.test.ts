import { describe, expect, test } from "bun:test";

import { InMemoryCreditsService } from "../core/in-memory-credits.js";
import { guardMutableMethods, type ScopeMutationGuard } from "./scope-guard.js";

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
});
