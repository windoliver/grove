import { describe, expect, test } from "bun:test";
import type { TuiDataProvider } from "../provider.js";
import { runTuiActionRegistration } from "./actions.js";
import type { TuiActionRegistration, TuiPluginContext } from "./types.js";

function context(): TuiPluginContext {
  return {
    provider: {} as TuiDataProvider,
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
