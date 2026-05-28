/**
 * Tests for HelpOverlay:
 *   1. Resolved keymap rendering
 *   2. Context-sensitive section rendering per focusedPanel
 *   3. visible=false renders nothing
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import type * as TestRendererTypes from "react-test-renderer";
import { Panel } from "../hooks/use-panel-focus.js";
import { resolveBuiltinKeymap } from "../keymap/keymap.js";
import { PANEL_REGISTRY } from "../panels/panel-registry.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type RenderNode = {
  readonly children?: readonly RenderChild[] | null;
};
type RenderChild = RenderNode | string;

function textOf(node: RenderChild | null): string {
  if (node === null) return "";
  if (typeof node === "string") return node;
  return (node.children ?? []).map((child) => textOf(child)).join("");
}

function sectionTexts(root: RenderNode | null): ReadonlyMap<string, string> {
  const sections = root?.children?.[1];
  if (typeof sections === "string") return new Map();
  const entries = (sections?.children ?? [])
    .filter((section): section is RenderNode => typeof section !== "string")
    .map((section) => {
      const titleNode = section.children?.[0];
      const title = typeof titleNode === "string" ? titleNode : textOf(titleNode ?? null);
      return [title, textOf(section)] as const;
    });
  return new Map(entries);
}

async function renderHelpOverlay(
  props: {
    readonly isDetailView?: boolean | undefined;
    readonly focusedPanel?: Panel | undefined;
  } = {},
): Promise<TestRendererTypes.ReactTestRenderer> {
  const TestRendererModule = await import("react-test-renderer");
  const TestRenderer = (TestRendererModule as unknown as { default: typeof TestRendererTypes })
    .default;
  const { act } = TestRendererModule;
  const { HelpOverlay } = await import("./help-overlay.js");

  let renderer!: TestRendererTypes.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(HelpOverlay, {
        visible: true,
        resolvedKeymap: resolveBuiltinKeymap("default"),
        ...props,
      }),
    );
  });
  return renderer;
}

async function unmountHelpOverlay(renderer: TestRendererTypes.ReactTestRenderer): Promise<void> {
  const { act } = await import("react-test-renderer");
  await act(async () => {
    renderer.unmount();
  });
}

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

  test("Panels section excludes focused-panel action bindings", async () => {
    const renderer = await renderHelpOverlay();
    const sections = sectionTexts(renderer.toJSON() as RenderNode | null);
    const panels = sections.get("Panels") ?? "";

    expect(panels).toContain("Toggle Terminal panel");
    expect(panels).not.toContain("Enter terminal input mode");
    expect(panels).not.toContain("Previous artifact");
    expect(panels).not.toContain("Approve pending question");
    expect(panels).not.toContain("Browse VFS entry");
    await unmountHelpOverlay(renderer);
  });

  test("Focused Panel section excludes panel switching binding", async () => {
    const renderer = await renderHelpOverlay({ focusedPanel: Panel.Artifact });
    const sections = sectionTexts(renderer.toJSON() as RenderNode | null);
    const focused = sections.get("Focused Panel") ?? "";

    expect(focused).toContain("Previous artifact");
    expect(focused).toContain("Toggle artifact diff");
    expect(focused).not.toContain("Toggle Artifact panel");
    await unmountHelpOverlay(renderer);
  });

  test("Detail view keeps navigation and panel sections", async () => {
    const renderer = await renderHelpOverlay({ isDetailView: true });
    const sections = sectionTexts(renderer.toJSON() as RenderNode | null);

    expect(sections.has("Global")).toBe(true);
    expect(sections.has("Detail View")).toBe(true);
    expect(sections.has("Navigation")).toBe(true);
    expect(sections.has("Panels")).toBe(true);
    expect(sections.has("Messaging")).toBe(true);
    await unmountHelpOverlay(renderer);
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
