/**
 * Tests for the panel registry pure functions.
 */

import { describe, expect, it } from "bun:test";
import { initialPanelState, Panel, panelFocus, panelToggle } from "../hooks/use-panel-focus.js";
import {
  getActivePanelsForLayout,
  getRegistry,
  getRowFlex,
  getRowGroups,
  getVisiblePanelsForLayout,
  isRowVisible,
  PANEL_REGISTRY,
  panelRowGroup,
} from "./panel-registry.js";

// ---------------------------------------------------------------------------
// getRegistry()
// ---------------------------------------------------------------------------

describe("getRegistry", () => {
  it("returns all panels from the registry", () => {
    const registry = getRegistry();
    expect(registry).toBe(PANEL_REGISTRY);
    expect(registry.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// getRowGroups()
// ---------------------------------------------------------------------------

describe("getRowGroups", () => {
  it("groups panels by row group number", () => {
    const groups = getRowGroups();
    expect(groups.size).toBeGreaterThan(0);

    // Row 0 has Dag + Detail
    const row0 = groups.get(0);
    expect(row0).toBeDefined();
    const row0Panels = row0!.map((d) => d.panel);
    expect(row0Panels).toContain(Panel.Dag);
    expect(row0Panels).toContain(Panel.Detail);
    expect(row0Panels.length).toBe(2);
  });

  it("row 1 has Frontier", () => {
    const groups = getRowGroups();
    const row1 = groups.get(1);
    expect(row1).toBeDefined();
    expect(row1!.length).toBe(1);
    expect(row1![0]!.panel).toBe(Panel.Frontier);
  });

  it("row 2 has Claims", () => {
    const groups = getRowGroups();
    const row2 = groups.get(2);
    expect(row2).toBeDefined();
    expect(row2!.length).toBe(1);
    expect(row2![0]!.panel).toBe(Panel.Claims);
  });

  it("row 3 has AgentList + Terminal", () => {
    const groups = getRowGroups();
    const row3 = groups.get(3);
    expect(row3).toBeDefined();
    const row3Panels = row3!.map((d) => d.panel);
    expect(row3Panels).toContain(Panel.AgentList);
    expect(row3Panels).toContain(Panel.Terminal);
  });
});

// ---------------------------------------------------------------------------
// getVisiblePanelsForLayout()
// ---------------------------------------------------------------------------

describe("getVisiblePanelsForLayout", () => {
  it("in grid mode returns core + visible operator panels", () => {
    let state = initialPanelState();
    state = panelToggle(state, Panel.Terminal);

    const visible = getVisiblePanelsForLayout(state, "grid");
    const panels = visible.map((d) => d.panel);

    // Core panels always present
    expect(panels).toContain(Panel.Dag);
    expect(panels).toContain(Panel.Detail);
    expect(panels).toContain(Panel.Frontier);
    expect(panels).toContain(Panel.Claims);

    // Toggled operator panel present
    expect(panels).toContain(Panel.Terminal);

    // Non-toggled operator panel absent
    expect(panels).not.toContain(Panel.Artifact);
  });

  it("in grid mode returns only core panels when no operators visible", () => {
    const state = initialPanelState();
    const visible = getVisiblePanelsForLayout(state, "grid");
    const panels = visible.map((d) => d.panel);
    expect(panels).toEqual([Panel.Dag, Panel.Detail, Panel.Frontier, Panel.Claims]);
  });

  it("in tab mode returns only focused panel", () => {
    const state = panelFocus(initialPanelState(), Panel.Frontier);
    const visible = getVisiblePanelsForLayout(state, "tab");
    expect(visible.length).toBe(1);
    expect(visible[0]!.panel).toBe(Panel.Frontier);
  });

  it("in tab mode returns focused operator panel", () => {
    let state = panelToggle(initialPanelState(), Panel.Terminal);
    state = panelFocus(state, Panel.Terminal);
    const visible = getVisiblePanelsForLayout(state, "tab");
    expect(visible.length).toBe(1);
    expect(visible[0]!.panel).toBe(Panel.Terminal);
  });
});

// ---------------------------------------------------------------------------
// getActivePanelsForLayout()
// ---------------------------------------------------------------------------

describe("getActivePanelsForLayout", () => {
  it("in grid mode returns all visible panels", () => {
    let state = initialPanelState();
    state = panelToggle(state, Panel.Terminal);

    const active = getActivePanelsForLayout(state, "grid");
    expect(active.has(Panel.Dag)).toBe(true);
    expect(active.has(Panel.Detail)).toBe(true);
    expect(active.has(Panel.Frontier)).toBe(true);
    expect(active.has(Panel.Claims)).toBe(true);
    expect(active.has(Panel.Terminal)).toBe(true);
    expect(active.has(Panel.Artifact)).toBe(false);
  });

  it("in tab mode returns only focused panel", () => {
    const state = panelFocus(initialPanelState(), Panel.Frontier);
    const active = getActivePanelsForLayout(state, "tab");
    expect(active.size).toBe(1);
    expect(active.has(Panel.Frontier)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getRowFlex()
// ---------------------------------------------------------------------------

describe("getRowFlex", () => {
  it("returns baseFlex in normal zoom", () => {
    expect(getRowFlex(0, 0, "normal")).toBe(1);
    expect(getRowFlex(1, 0, "normal")).toBe(1);
    expect(getRowFlex(0, 0, "normal", 2)).toBe(2);
  });

  it("returns baseFlex * 3 for focused row in half zoom", () => {
    expect(getRowFlex(0, 0, "half")).toBe(3); // focused row: 1 * 3
    expect(getRowFlex(0, 0, "half", 2)).toBe(6); // focused row: 2 * 3
  });

  it("returns 1 for non-focused row in half zoom", () => {
    expect(getRowFlex(1, 0, "half")).toBe(1);
    expect(getRowFlex(2, 0, "half")).toBe(1);
  });

  it("returns baseFlex in full zoom", () => {
    expect(getRowFlex(0, 0, "full")).toBe(1);
    expect(getRowFlex(0, 0, "full", 2)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// isRowVisible()
// ---------------------------------------------------------------------------

describe("isRowVisible", () => {
  it("all rows visible in normal zoom", () => {
    expect(isRowVisible(0, 0, "normal")).toBe(true);
    expect(isRowVisible(1, 0, "normal")).toBe(true);
    expect(isRowVisible(2, 0, "normal")).toBe(true);
  });

  it("all rows visible in half zoom", () => {
    expect(isRowVisible(0, 0, "half")).toBe(true);
    expect(isRowVisible(1, 0, "half")).toBe(true);
  });

  it("only focused row visible in full zoom", () => {
    expect(isRowVisible(0, 0, "full")).toBe(true);
    expect(isRowVisible(1, 0, "full")).toBe(false);
    expect(isRowVisible(2, 0, "full")).toBe(false);
    expect(isRowVisible(3, 3, "full")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// panelRowGroup()
// ---------------------------------------------------------------------------

describe("panelRowGroup", () => {
  it("returns row 0 for Dag and Detail", () => {
    expect(panelRowGroup(Panel.Dag)).toBe(0);
    expect(panelRowGroup(Panel.Detail)).toBe(0);
  });

  it("returns row 1 for Frontier", () => {
    expect(panelRowGroup(Panel.Frontier)).toBe(1);
  });

  it("returns row 2 for Claims", () => {
    expect(panelRowGroup(Panel.Claims)).toBe(2);
  });

  it("returns row 3 for AgentList and Terminal", () => {
    expect(panelRowGroup(Panel.AgentList)).toBe(3);
    expect(panelRowGroup(Panel.Terminal)).toBe(3);
  });

  it("returns row 4 for Artifact and Vfs", () => {
    expect(panelRowGroup(Panel.Artifact)).toBe(4);
    expect(panelRowGroup(Panel.Vfs)).toBe(4);
  });

  it("returns row 5 for Activity and Search", () => {
    expect(panelRowGroup(Panel.Activity)).toBe(5);
    expect(panelRowGroup(Panel.Search)).toBe(5);
  });

  it("returns row 6 for Threads and Outcomes", () => {
    expect(panelRowGroup(Panel.Threads)).toBe(6);
    expect(panelRowGroup(Panel.Outcomes)).toBe(6);
  });

  it("returns row 7 for Bounties and Gossip", () => {
    expect(panelRowGroup(Panel.Bounties)).toBe(7);
    expect(panelRowGroup(Panel.Gossip)).toBe(7);
  });

  it("returns row 8 for Inbox, Decisions, and GitHub", () => {
    expect(panelRowGroup(Panel.Inbox)).toBe(8);
    expect(panelRowGroup(Panel.Decisions)).toBe(8);
    expect(panelRowGroup(Panel.GitHub)).toBe(8);
  });
});
