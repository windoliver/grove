import { describe, expect, test } from "bun:test";
import { Panel } from "../hooks/use-panel-focus.js";
import {
  collectTuiActionRegistrations,
  collectTuiPanelRegistrations,
  mergeTuiActionRegistrations,
  mergeTuiRegistrations,
  type TuiActionRegistryEntry,
  type TuiRegistryEntry,
} from "./registry.js";
import type { TuiActionRegistration, TuiExtension, TuiPanelRegistration } from "./types.js";

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

function builtInAction(id: string, order: number): TuiActionRegistryEntry {
  return {
    id,
    label: id,
    detail: `${id} detail`,
    order,
    source: "builtin",
    builtInAction: id,
  };
}

function action(id: string, order?: number): TuiActionRegistration {
  return {
    id,
    label: id,
    detail: `${id} detail`,
    ...(order === undefined ? {} : { order }),
    run: () => undefined,
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

  test("keeps first plugin entry and skips duplicate plugin IDs", () => {
    const result = mergeTuiRegistrations({
      builtIns: [builtIn("dag", 10, Panel.Dag)],
      plugins: [plugin("audit-feed", 20), plugin("audit-feed", 30)],
    });

    expect(result.entries.map((entry) => entry.id)).toEqual(["dag", "audit-feed"]);
    expect(result.entries[1]?.order).toBe(20);
    expect(result.diagnostics).toEqual([
      {
        id: "audit-feed",
        severity: "error",
        message: "Duplicate TUI panel id: audit-feed",
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

  test("uses default plugin order 1000 when order is omitted", () => {
    const result = mergeTuiRegistrations({
      builtIns: [builtIn("dag", 10, Panel.Dag)],
      plugins: [plugin("eval-results")],
    });

    expect(result.entries.map((entry) => entry.id)).toEqual(["dag", "eval-results"]);
    expect(result.entries[1]?.order).toBe(1000);
  });

  test("uses default plugin order and reports diagnostics for invalid orders", () => {
    const result = mergeTuiRegistrations({
      builtIns: [builtIn("dag", 10, Panel.Dag)],
      plugins: [
        plugin("nan-order", Number.NaN),
        plugin("infinite-order", Number.POSITIVE_INFINITY),
      ],
    });

    expect(result.entries.map((entry) => [entry.id, entry.order])).toEqual([
      ["dag", 10],
      ["infinite-order", 1000],
      ["nan-order", 1000],
    ]);
    expect(result.diagnostics).toEqual([
      {
        id: "nan-order",
        severity: "error",
        message: "Invalid TUI panel order for nan-order; using default order 1000",
      },
      {
        id: "infinite-order",
        severity: "error",
        message: "Invalid TUI panel order for infinite-order; using default order 1000",
      },
    ]);
  });

  test("throws when built-in panel ID is unsafe", () => {
    expect(() =>
      mergeTuiRegistrations({
        builtIns: [builtIn("bad/id", 10, Panel.Dag)],
      }),
    ).toThrow("Built-in TUI panel has invalid id: bad/id");
  });

  test("throws when built-in panel ID is duplicated", () => {
    expect(() =>
      mergeTuiRegistrations({
        builtIns: [builtIn("dag", 10, Panel.Dag), builtIn("dag", 20, Panel.Claims)],
      }),
    ).toThrow("Built-in TUI panel id is duplicated: dag");
  });
});

describe("TuiExtension collection", () => {
  test("flattens panel and action registrations from extensions", () => {
    const panel = plugin("audit-panel", 20);
    const refresh = action("audit-refresh", 30);
    const extension: TuiExtension = {
      id: "audit",
      name: "Audit",
      version: "1.0.0",
      panels: [panel],
      actions: [refresh],
    };

    expect(collectTuiPanelRegistrations([extension])).toEqual([panel]);
    expect(collectTuiActionRegistrations([extension])).toEqual([refresh]);
  });

  test("returns empty frozen arrays when extensions are absent", () => {
    expect(collectTuiPanelRegistrations()).toEqual([]);
    expect(collectTuiActionRegistrations()).toEqual([]);
  });
});

describe("mergeTuiActionRegistrations", () => {
  test("orders built-in and plugin action entries by order then id", () => {
    const result = mergeTuiActionRegistrations({
      builtIns: [builtInAction("register-agent", 10), builtInAction("set-goal", 30)],
      plugins: [action("audit-refresh", 20), action("audit-export", 20)],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.entries.map((entry) => entry.id)).toEqual([
      "register-agent",
      "audit-export",
      "audit-refresh",
      "set-goal",
    ]);
  });

  test("skips plugin actions that duplicate built-in action IDs", () => {
    const result = mergeTuiActionRegistrations({
      builtIns: [builtInAction("register-agent", 10)],
      plugins: [action("register-agent", 20)],
    });

    expect(result.entries.map((entry) => entry.id)).toEqual(["register-agent"]);
    expect(result.diagnostics).toEqual([
      {
        id: "register-agent",
        severity: "error",
        message: "Duplicate TUI action id: register-agent",
      },
    ]);
  });

  test("skips plugin actions with unsafe IDs", () => {
    const result = mergeTuiActionRegistrations({
      builtIns: [builtInAction("register-agent", 10)],
      plugins: [action("bad/id", 20), action("UpperCase", 30)],
    });

    expect(result.entries.map((entry) => entry.id)).toEqual(["register-agent"]);
    expect(result.diagnostics).toEqual([
      {
        id: "bad/id",
        severity: "error",
        message: "Invalid TUI action id: bad/id",
      },
      {
        id: "UpperCase",
        severity: "error",
        message: "Invalid TUI action id: UpperCase",
      },
    ]);
  });

  test("uses default plugin action order 1000 when order is omitted", () => {
    const result = mergeTuiActionRegistrations({
      builtIns: [builtInAction("register-agent", 10)],
      plugins: [action("audit-refresh")],
    });

    expect(result.entries.map((entry) => [entry.id, entry.order])).toEqual([
      ["register-agent", 10],
      ["audit-refresh", 1000],
    ]);
  });

  test("uses default action order and reports diagnostics for invalid orders", () => {
    const result = mergeTuiActionRegistrations({
      builtIns: [builtInAction("register-agent", 10)],
      plugins: [
        action("nan-action", Number.NaN),
        action("infinite-action", Number.POSITIVE_INFINITY),
      ],
    });

    expect(result.entries.map((entry) => [entry.id, entry.order])).toEqual([
      ["register-agent", 10],
      ["infinite-action", 1000],
      ["nan-action", 1000],
    ]);
    expect(result.diagnostics).toEqual([
      {
        id: "nan-action",
        severity: "error",
        message: "Invalid TUI action order for nan-action; using default order 1000",
      },
      {
        id: "infinite-action",
        severity: "error",
        message: "Invalid TUI action order for infinite-action; using default order 1000",
      },
    ]);
  });

  test("throws when built-in action IDs are unsafe or duplicated", () => {
    expect(() =>
      mergeTuiActionRegistrations({
        builtIns: [builtInAction("bad/id", 10)],
      }),
    ).toThrow("Built-in TUI action has invalid id: bad/id");

    expect(() =>
      mergeTuiActionRegistrations({
        builtIns: [builtInAction("register-agent", 10), builtInAction("register-agent", 20)],
      }),
    ).toThrow("Built-in TUI action id is duplicated: register-agent");
  });
});
