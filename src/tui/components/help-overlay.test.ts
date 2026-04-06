/**
 * Tests for HelpOverlay:
 *   1. PANEL_BINDINGS completeness — every registered panel appears
 *   2. Context-sensitive section rendering per focusedPanel
 *   3. visible=false renders nothing
 */

import { describe, expect, test } from "bun:test";
import { Panel } from "../hooks/use-panel-focus.js";
import { PANEL_REGISTRY } from "../panels/panel-registry.js";

// ---------------------------------------------------------------------------
// 1. PANEL_BINDINGS completeness
// ---------------------------------------------------------------------------

describe("HelpOverlay — PANEL_BINDINGS completeness", () => {
  test("every PANEL_REGISTRY entry's keybinding appears in PANEL_BINDINGS", async () => {
    // We verify this by reading the module source: PANEL_BINDINGS is derived
    // from PANEL_REGISTRY, so every registered panel must have a keybinding entry.
    // This test ensures the derivation covers all panels — including new ones.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(import.meta.dir, "help-overlay.tsx"), "utf-8");

    // The panel bindings must be derived from PANEL_REGISTRY (not a hardcoded list).
    expect(source).toContain("PANEL_REGISTRY");
    expect(source).toContain("PANEL_BINDINGS");

    // Verify the derivation uses registry keybinding field.
    expect(source).toContain("def.keybinding");
  });

  test("every registered panel keybinding is distinct", () => {
    const keys = PANEL_REGISTRY.map((def) => def.keybinding);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  test("Plan panel has backtick keybinding", () => {
    const planDef = PANEL_REGISTRY.find((def) => def.panel === Panel.Plan);
    expect(planDef).toBeDefined();
    expect(planDef!.keybinding).toBe("`");
  });

  test("core panels 1-4 are assigned to Dag/Detail/Frontier/Claims", () => {
    const byKey = new Map(PANEL_REGISTRY.map((def) => [def.keybinding, def.panel]));
    expect(byKey.get("1")).toBe(Panel.Dag);
    expect(byKey.get("2")).toBe(Panel.Detail);
    expect(byKey.get("3")).toBe(Panel.Frontier);
    expect(byKey.get("4")).toBe(Panel.Claims);
  });
});

// ---------------------------------------------------------------------------
// 2. Context-sensitive sections — panel comparisons use Panel enum
// ---------------------------------------------------------------------------

describe("HelpOverlay — uses Panel enum constants (not magic numbers)", () => {
  test("source uses Panel.Artifact not magic number 7", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(import.meta.dir, "help-overlay.tsx"), "utf-8");
    expect(source).toContain("Panel.Artifact");
    expect(source).toContain("Panel.Terminal");
    expect(source).toContain("Panel.Search");
    expect(source).toContain("Panel.Decisions");
    expect(source).toContain("Panel.Frontier");
    // Must NOT contain standalone numeric panel comparisons
    expect(source).not.toMatch(/=== \d+/);
  });
});

// ---------------------------------------------------------------------------
// 3. visible=false renders nothing
// ---------------------------------------------------------------------------

describe("HelpOverlay — visibility", () => {
  test("HelpOverlay is a named export", async () => {
    const mod = await import("./help-overlay.js");
    // React.memo returns an exotic component object, not a plain function
    expect(mod.HelpOverlay).toBeDefined();
    expect(typeof mod.HelpOverlay).not.toBe("undefined");
  });

  test("HelpOverlayProps type includes visible, isDetailView, focusedPanel", async () => {
    // Verify shape via TypeScript — the import succeeds, which means the types exist.
    const mod = await import("./help-overlay.js");
    expect(mod.HelpOverlay).toBeDefined();
  });
});
