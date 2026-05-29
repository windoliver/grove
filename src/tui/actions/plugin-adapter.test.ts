import { describe, expect, mock, test } from "bun:test";
import { mergeTuiActionRegistrations } from "../plugins/registry.js";
import type { TuiActionRegistration, TuiPluginContext } from "../plugins/types.js";
import { buildPluginActions } from "./plugin-adapter.js";

const pluginCtx = {
  density: "compact",
  showMessage: () => undefined,
} as unknown as TuiPluginContext;

function reg(o: Partial<TuiActionRegistration> = {}): TuiActionRegistration {
  return {
    id: "audit-refresh",
    label: "Refresh audit",
    detail: "audit",
    run: () => undefined,
    ...o,
  };
}

describe("buildPluginActions", () => {
  test("wraps plugin registrations as Plugins-group actions", () => {
    const merged = mergeTuiActionRegistrations({ builtIns: [], plugins: [reg()] });
    const actions = buildPluginActions(merged.entries, () => pluginCtx);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.id).toBe("audit-refresh");
    expect(actions[0]?.group).toBe("Plugins");
    expect(actions[0]?.label).toBe("Refresh audit");
  });

  test("run delegates to the registration with the narrow plugin context", async () => {
    const run = mock(() => undefined);
    const merged = mergeTuiActionRegistrations({ builtIns: [], plugins: [reg({ run })] });
    const actions = buildPluginActions(merged.entries, () => pluginCtx);
    // ActionContext arg is ignored by the adapter; pass an empty stub.
    await actions[0]?.run({} as never);
    expect(run).toHaveBeenCalledTimes(1);
    expect((run.mock.calls as unknown as [TuiPluginContext[]])[0]?.[0]).toBe(pluginCtx);
  });

  test("enabled delegates to the registration predicate via plugin context", () => {
    const enabled = mock((c: TuiPluginContext) => c.density === "compact");
    const merged = mergeTuiActionRegistrations({ builtIns: [], plugins: [reg({ enabled })] });
    const actions = buildPluginActions(merged.entries, () => pluginCtx);
    expect(actions[0]?.enabled?.({} as never)).toBe(true);
    expect(enabled).toHaveBeenCalledTimes(1);
  });
});
