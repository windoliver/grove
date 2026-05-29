import { describe, expect, test } from "bun:test";
import { Panel } from "../hooks/use-panel-focus.js";
import { PanelId } from "../panels/panel-ids.js";
import { type KeyBinding, resolveBuiltinKeymap } from "./keymap.js";
import { bindingToActionId, resolvedKeymapBindings } from "./keymap-action-map.js";

describe("bindingToActionId", () => {
  test("maps a non-panel action binding to its registry id", () => {
    const b = {
      id: "quit",
      action: "quit",
      sequence: ["q"],
      label: "Quit",
      context: "global",
      layer: "normal",
      preferred: true,
    } as KeyBinding;
    expect(bindingToActionId(b)).toBe("view.quit");
  });
  test("maps a focus_panel binding to nav.panel.<id>", () => {
    const b = {
      id: `focus_panel:${PanelId.Terminal}`,
      action: "focus_panel",
      sequence: ["t"],
      label: "Terminal",
      context: "navigation",
      layer: "normal",
      panel: Panel.Terminal,
      preferred: true,
    } as KeyBinding;
    expect(bindingToActionId(b)).toBe("nav.panel.terminal");
  });
});

describe("resolvedKeymapBindings", () => {
  test("produces id→keybind entries from a resolved keymap", () => {
    const map = resolvedKeymapBindings(resolveBuiltinKeymap("default"));
    expect(map.get("view.quit")).toBeDefined();
  });
});
