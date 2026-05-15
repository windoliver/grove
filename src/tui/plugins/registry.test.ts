import { describe, expect, test } from "bun:test";
import { Panel } from "../hooks/use-panel-focus.js";
import { mergeTuiRegistrations, type TuiRegistryEntry } from "./registry.js";
import type { TuiPanelRegistration } from "./types.js";

const NullPanel = () => null;

function builtIn(id: string, order: number, panel: Panel): TuiRegistryEntry {
  return {
    id,
    label: id,
    slot: "operator-panel",
    order,
    source: "builtin",
    builtInPanel: panel,
  };
}

function plugin(id: string, order?: number): TuiPanelRegistration {
  return {
    id,
    label: id,
    slot: "operator-panel",
    ...(order === undefined ? {} : { order }),
    component: NullPanel,
  };
}

describe("mergeTuiRegistrations", () => {
  test("orders built-in and plugin entries by order then id", () => {
    const result = mergeTuiRegistrations({
      builtIns: [builtIn("dag", 10, Panel.Dag), builtIn("claims", 30, Panel.Claims)],
      plugins: [plugin("eval-results", 20), plugin("audit-feed", 20)],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.entries.map((entry) => entry.id)).toEqual([
      "dag",
      "audit-feed",
      "eval-results",
      "claims",
    ]);
  });

  test("skips plugin entries that duplicate built-in IDs", () => {
    const result = mergeTuiRegistrations({
      builtIns: [builtIn("dag", 10, Panel.Dag)],
      plugins: [plugin("dag", 20)],
    });

    expect(result.entries.map((entry) => entry.id)).toEqual(["dag"]);
    expect(result.diagnostics).toEqual([
      {
        id: "dag",
        severity: "error",
        message: "Duplicate TUI panel id: dag",
      },
    ]);
  });

  test("skips plugin entries with unsafe IDs", () => {
    const result = mergeTuiRegistrations({
      builtIns: [builtIn("dag", 10, Panel.Dag)],
      plugins: [plugin("bad/id", 20), plugin("UpperCase", 30)],
    });

    expect(result.entries.map((entry) => entry.id)).toEqual(["dag"]);
    expect(result.diagnostics).toEqual([
      {
        id: "bad/id",
        severity: "error",
        message: "Invalid TUI panel id: bad/id",
      },
      {
        id: "UpperCase",
        severity: "error",
        message: "Invalid TUI panel id: UpperCase",
      },
    ]);
  });

  test("uses default plugin order after built-ins when order is omitted", () => {
    const result = mergeTuiRegistrations({
      builtIns: [builtIn("dag", 10, Panel.Dag)],
      plugins: [plugin("eval-results")],
    });

    expect(result.entries.map((entry) => entry.id)).toEqual(["dag", "eval-results"]);
    expect(result.entries[1]?.order).toBe(1000);
  });
});
