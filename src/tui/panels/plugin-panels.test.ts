import { describe, expect, test } from "bun:test";
import type React from "react";
import { Panel } from "../hooks/use-panel-focus.js";
import type { TuiRegistryEntry } from "../plugins/registry.js";
import type { TuiPluginContext, TuiSlot } from "../plugins/types.js";
import {
  getDefaultVisiblePluginPanelEntries,
  shouldRenderDefaultVisiblePluginPanels,
} from "./plugin-panels.js";

const NullPanel: React.ComponentType<TuiPluginContext> = () => null;

function builtInEntry(id: string, order: number, panel: Panel): TuiRegistryEntry {
  return {
    id,
    label: id,
    slot: "operator-panel",
    order,
    source: "builtin",
    builtInPanel: panel,
  };
}

function pluginEntry(
  id: string,
  defaultVisible?: boolean,
  slot: TuiSlot = "operator-panel",
): TuiRegistryEntry {
  return {
    id,
    label: id,
    slot,
    order: 1000,
    source: "plugin",
    registration: {
      id,
      label: id,
      slot,
      ...(defaultVisible === undefined ? {} : { defaultVisible }),
      component: NullPanel,
    },
  };
}

describe("getDefaultVisiblePluginPanelEntries", () => {
  test("returns only plugin operator panels with defaultVisible true", () => {
    const entries: readonly TuiRegistryEntry[] = [
      builtInEntry("dag", 0, Panel.Dag),
      pluginEntry("audit-panel", true),
      pluginEntry("hidden-panel", false),
      pluginEntry("implicit-hidden"),
      pluginEntry("footer-panel", true, "footer"),
    ];

    expect(getDefaultVisiblePluginPanelEntries(entries).map((entry) => entry.id)).toEqual([
      "audit-panel",
    ]);
  });

  test("skips plugin entries without registrations", () => {
    const entries: readonly TuiRegistryEntry[] = [
      {
        id: "broken-panel",
        label: "Broken",
        slot: "operator-panel",
        order: 1000,
        source: "plugin",
      },
    ];

    expect(getDefaultVisiblePluginPanelEntries(entries)).toEqual([]);
  });
});

describe("shouldRenderDefaultVisiblePluginPanels", () => {
  test("renders only in unsuppressed grid layout", () => {
    expect(
      shouldRenderDefaultVisiblePluginPanels({
        layoutMode: "grid",
        zoomLevel: "normal",
        isMedium: false,
      }),
    ).toBe(true);
  });

  test("does not render in tab layout", () => {
    expect(
      shouldRenderDefaultVisiblePluginPanels({
        layoutMode: "tab",
        zoomLevel: "normal",
        isMedium: false,
      }),
    ).toBe(false);
  });

  test("does not render in full zoom", () => {
    expect(
      shouldRenderDefaultVisiblePluginPanels({
        layoutMode: "grid",
        zoomLevel: "full",
        isMedium: false,
      }),
    ).toBe(false);
  });

  test("does not render in medium layout", () => {
    expect(
      shouldRenderDefaultVisiblePluginPanels({
        layoutMode: "grid",
        zoomLevel: "normal",
        isMedium: true,
      }),
    ).toBe(false);
  });
});
