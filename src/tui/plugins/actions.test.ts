import { describe, expect, test } from "bun:test";
import type { TuiDataProvider } from "../provider.js";
import { runTuiActionRegistration } from "./actions.js";
import type { TuiActionRegistration, TuiPluginContext } from "./types.js";

function providerStub(): TuiDataProvider {
  return {
    capabilities: {
      outcomes: false,
      artifacts: false,
      vfs: false,
      messaging: false,
      costTracking: false,
      askUser: false,
      github: false,
      bounties: false,
      gossip: false,
      goals: false,
      sessions: false,
      handoffs: false,
    },
    getDashboard: async () => {
      throw new Error("getDashboard not used");
    },
    getContributions: async () => [],
    getContribution: async () => undefined,
    getClaims: async () => [],
    getFrontier: async () => ({
      byMetric: {},
      byAdoption: [],
      byRecency: [],
      byReviewScore: [],
      byReproduction: [],
    }),
    getActivity: async () => [],
    getDag: async () => ({ contributions: [] }),
    getHotThreads: async () => [],
    close: () => undefined,
  };
}

function context(): TuiPluginContext {
  return {
    provider: providerStub(),
    density: "comfortable",
    showMessage: () => undefined,
  };
}

describe("runTuiActionRegistration", () => {
  test("runs synchronous action callbacks with plugin context", async () => {
    let receivedDensity = "";
    const action: TuiActionRegistration = {
      id: "audit-refresh",
      label: "Refresh audit panel",
      detail: "audit",
      run: (ctx) => {
        receivedDensity = ctx.density;
      },
    };

    await runTuiActionRegistration(action, context());

    expect(receivedDensity).toBe("comfortable");
  });

  test("runs asynchronous action callbacks", async () => {
    let completed = false;
    const action: TuiActionRegistration = {
      id: "audit-refresh",
      label: "Refresh audit panel",
      detail: "audit",
      run: async () => {
        await Promise.resolve();
        completed = true;
      },
    };

    await runTuiActionRegistration(action, context());

    expect(completed).toBe(true);
  });

  test("propagates action failures to the caller", async () => {
    const action: TuiActionRegistration = {
      id: "audit-refresh",
      label: "Refresh audit panel",
      detail: "audit",
      run: () => {
        throw new Error("audit failed");
      },
    };

    await expect(runTuiActionRegistration(action, context())).rejects.toThrow("audit failed");
  });
});
