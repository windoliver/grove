import { describe, expect, mock, test } from "bun:test";
import { mergeTuiActionRegistrations } from "../plugins/registry.js";
import type { TuiActionRegistration, TuiPluginContext } from "../plugins/types.js";
import type { TuiDataProvider } from "../provider.js";
import {
  buildPluginPaletteItems,
  getBuiltInPaletteActionRegistryEntries,
} from "./command-palette.js";

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
    density: "compact",
    showMessage: () => undefined,
  };
}

function action(overrides: Partial<TuiActionRegistration> = {}): TuiActionRegistration {
  return {
    id: "audit-refresh",
    label: "Refresh audit panel",
    detail: "audit",
    run: () => undefined,
    ...overrides,
  };
}

describe("plugin palette items", () => {
  test("includes fixed built-in action IDs for duplicate protection", () => {
    expect(getBuiltInPaletteActionRegistryEntries().map((entry) => entry.id)).toEqual([
      "set-goal",
      "register-agent",
    ]);
  });

  test("projects enabled plugin actions into palette items", () => {
    const refresh = action();
    const merged = mergeTuiActionRegistrations({
      builtIns: getBuiltInPaletteActionRegistryEntries(),
      plugins: [refresh],
    });

    const items = buildPluginPaletteItems(merged.entries, context());

    expect(
      items.map((item) => [item.kind, item.id, item.label, item.detail, item.enabled]),
    ).toEqual([["plugin-action", "audit-refresh", "Refresh audit panel", "audit", true]]);
    expect(items[0]?.pluginAction).toBe(refresh);
  });

  test("projects disabled plugin actions as non-executable palette items", () => {
    const refresh = action({ enabled: () => false });
    const merged = mergeTuiActionRegistrations({
      builtIns: getBuiltInPaletteActionRegistryEntries(),
      plugins: [refresh],
    });

    const items = buildPluginPaletteItems(merged.entries, context());

    expect(items[0]?.enabled).toBe(false);
  });

  test("evaluates enabled predicate with the plugin context", () => {
    const enabled = mock((ctx: TuiPluginContext) => ctx.density === "compact");
    const refresh = action({ enabled });
    const merged = mergeTuiActionRegistrations({
      builtIns: getBuiltInPaletteActionRegistryEntries(),
      plugins: [refresh],
    });

    const items = buildPluginPaletteItems(merged.entries, context());

    expect(items[0]?.enabled).toBe(true);
    expect(enabled).toHaveBeenCalledTimes(1);
  });
});
