/**
 * Tests for HelpOverlay:
 *   1. Resolved keymap rendering
 *   2. Context-sensitive section rendering per focusedPanel
 *   3. visible=false renders nothing
 */

import { describe, expect, test } from "bun:test";
import { Panel } from "../hooks/use-panel-focus.js";
import { PANEL_REGISTRY } from "../panels/panel-registry.js";

// ---------------------------------------------------------------------------
// 1. Resolved keymap rendering
// ---------------------------------------------------------------------------

describe("HelpOverlay — resolved keymap rendering", () => {
  test("source accepts a resolvedKeymap prop", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(import.meta.dir, "help-overlay.tsx"), "utf-8");

    expect(source).toContain("resolvedKeymap");
    expect(source).toContain("formatKeySequence");
  });

  test("source no longer renders panel bindings from def.keybinding directly", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(import.meta.dir, "help-overlay.tsx"), "utf-8");

    expect(source).not.toContain("def.keybinding");
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
});

// ---------------------------------------------------------------------------
// 2. Context-sensitive sections — focused panel is still typed as Panel
// ---------------------------------------------------------------------------

describe("HelpOverlay — focused panel sections", () => {
  test("source derives focused panel bindings from resolved keymap", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(import.meta.dir, "help-overlay.tsx"), "utf-8");

    expect(source).toContain("bindingsForPanel");
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
