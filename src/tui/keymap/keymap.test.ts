import { describe, expect, test } from "bun:test";
import { Panel } from "../hooks/use-panel-focus.js";
import {
  type ActionKeyBinding,
  createKeySequence,
  formatKeySequence,
  type KeyBinding,
  keyEventToToken,
  matchesKeySequence,
  normalizeKeyToken,
  parseKeySequence,
  resolveBuiltinKeymap,
  resolveKeyBinding,
  resolveKeySequence,
} from "./keymap.js";

function binding(
  id: ActionKeyBinding["id"],
  sequence: KeyBinding["sequence"],
  action: ActionKeyBinding["action"] = "help",
): ActionKeyBinding {
  return {
    id,
    action,
    sequence,
    label: id,
    context: "global",
    layer: "normal",
    preferred: true,
  };
}

describe("key token normalization", () => {
  test("parses display tokens into route tokens", () => {
    expect(parseKeySequence("Space p t")).toEqual(["space", "p", "t"]);
    expect(parseKeySequence("Esc")).toEqual(["escape"]);
    expect(parseKeySequence("Enter")).toEqual(["return"]);
    expect(parseKeySequence("Ctrl+P")).toEqual(["ctrl+p"]);
    expect(parseKeySequence("F5")).toEqual(["F5"]);
  });

  test("formats route tokens for display", () => {
    expect(formatKeySequence(["space", "p", "t"])).toBe("Space p t");
    expect(formatKeySequence(["ctrl+p"])).toBe("Ctrl+P");
    expect(formatKeySequence(["return"])).toBe("Enter");
  });

  test("creates immutable normalized key sequences", () => {
    const sequence = createKeySequence("Space p t");
    expect(sequence).toEqual(["space", "p", "t"]);
    expect(Object.isFrozen(sequence)).toBe(true);
  });

  test("distinguishes exact, prefix, and unmatched sequences", () => {
    expect(matchesKeySequence(["space", "p"], ["space", "p"])).toBe("exact");
    expect(matchesKeySequence(["space", "p", "t"], ["space", "p"])).toBe("prefix");
    expect(matchesKeySequence(["space", "p"], ["space", "x"])).toBe("none");
  });

  test("normalizes individual tokens", () => {
    expect(normalizeKeyToken("Space")).toBe("space");
    expect(normalizeKeyToken("escape")).toBe("escape");
    expect(normalizeKeyToken("Ctrl+p")).toBe("ctrl+p");
  });

  test("converts key events into route tokens", () => {
    expect(keyEventToToken({ name: "space", ctrl: false })).toBe("space");
    expect(keyEventToToken({ name: "p", ctrl: true })).toBe("ctrl+p");
    expect(keyEventToToken({ name: "F5", ctrl: false })).toBe("F5");
    expect(keyEventToToken({ name: "space", sequence: " " })).toBe("space");
    expect(keyEventToToken({ name: "/", sequence: "?", shift: true })).toBe("?");
    expect(keyEventToToken({ name: "v", shift: true })).toBe("V");
    expect(keyEventToToken({ name: "z", shift: true })).toBe("Z");
    expect(keyEventToToken({ name: "2", shift: true })).toBe("@");
  });
});

describe("resolveKeySequence", () => {
  const bindings: readonly KeyBinding[] = [
    { ...binding("help", ["space", "?"]), layer: "leader" },
    {
      id: "toggle_panel:terminal",
      action: "toggle_panel",
      sequence: ["space", "p", "t"],
      label: "terminal",
      context: "panel",
      layer: "leader",
      panel: Panel.Terminal,
      preferred: true,
    },
    binding("refresh", ["r"], "refresh"),
  ];

  test("leader prefix returns pending", () => {
    expect(resolveKeySequence(bindings, ["space"])).toEqual({
      kind: "pending",
      prefix: ["space"],
    });
  });

  test("nested prefix returns pending", () => {
    expect(resolveKeySequence(bindings, ["space", "p"])).toEqual({
      kind: "pending",
      prefix: ["space", "p"],
    });
  });

  test("complete sequence returns match", () => {
    const result = resolveKeySequence(bindings, ["space", "p", "t"]);
    expect(result.kind).toBe("match");
    if (result.kind === "match") expect(result.binding.id).toBe("toggle_panel:terminal");
  });

  test("exact match wins over a longer prefix candidate", () => {
    const ambiguous: readonly KeyBinding[] = [
      { ...binding("palette", ["space", "p"], "palette"), layer: "leader" },
      {
        id: "toggle_panel:terminal",
        action: "toggle_panel",
        sequence: ["space", "p", "t"],
        label: "terminal",
        context: "panel",
        layer: "leader",
        panel: Panel.Terminal,
        preferred: true,
      },
    ];

    const result = resolveKeyBinding(ambiguous, ["space", "p"]);

    expect(result.kind).toBe("match");
    if (result.kind === "match") expect(result.binding.id).toBe("palette");
  });

  test("panel-scoped bindings only match for the focused panel", () => {
    const scoped: readonly KeyBinding[] = [
      {
        ...binding("terminal_input", ["i"], "terminal_input"),
        context: "panel",
        layer: "panel",
        panel: Panel.Terminal,
      },
      binding("refresh", ["i"], "refresh"),
    ];

    const terminalResult = resolveKeyBinding(scoped, ["i"], { focusedPanel: Panel.Terminal });
    const dagResult = resolveKeyBinding(scoped, ["i"], { focusedPanel: Panel.Dag });

    expect(terminalResult.kind).toBe("match");
    if (terminalResult.kind === "match") expect(terminalResult.binding.id).toBe("terminal_input");
    expect(dagResult.kind).toBe("match");
    if (dagResult.kind === "match") expect(dagResult.binding.id).toBe("refresh");
  });

  test("direct sequence returns match", () => {
    const result = resolveKeySequence(bindings, ["r"]);
    expect(result.kind).toBe("match");
    if (result.kind === "match") expect(result.binding.id).toBe("refresh");
  });

  test("unknown sequence returns miss", () => {
    expect(resolveKeySequence(bindings, ["space", "x"])).toEqual({ kind: "miss" });
  });
});

describe("resolveBuiltinKeymap", () => {
  test("default preset follows the approved leader grammar", () => {
    const keymap = resolveBuiltinKeymap("default");

    expect(
      keymap.bindings.find((binding) => binding.id === "help" && binding.preferred)?.sequence,
    ).toEqual(["space", "?"]);
    expect(
      keymap.bindings.find((binding) => binding.id === "palette" && binding.preferred)?.sequence,
    ).toEqual(["space", "c", "p"]);
    expect(
      keymap.bindings.find((binding) => binding.id === "zoom_reset" && binding.preferred)?.sequence,
    ).toEqual(["space", "Z"]);
    expect(
      keymap.bindings.find((binding) => binding.id === "view_cycle" && binding.preferred)?.sequence,
    ).toEqual(["space", "V"]);
    expect(
      keymap.bindings.find((binding) => binding.id === "direct_message" && binding.preferred)
        ?.sequence,
    ).toEqual(["space", "m", "@"]);
  });

  test("default preset keeps essential direct navigation", () => {
    const keymap = resolveBuiltinKeymap("default");

    expect(keymap.bindings.find((binding) => binding.id === "cursor_down")?.sequence).toEqual([
      "j",
    ]);
    expect(keymap.bindings.find((binding) => binding.id === "cursor_up")?.sequence).toEqual(["k"]);
    expect(keymap.bindings.find((binding) => binding.id === "select")?.sequence).toEqual([
      "return",
    ]);
    expect(keymap.bindings.find((binding) => binding.id === "cycle_panel_next")?.sequence).toEqual([
      "tab",
    ]);
  });

  test("default preset focuses core panels with leader-number sequences", () => {
    const keymap = resolveBuiltinKeymap("default");

    expect(keymap.bindings.find((binding) => binding.id === "focus_panel:dag")?.sequence).toEqual([
      "space",
      "p",
      "1",
    ]);
    expect(
      keymap.bindings.find((binding) => binding.id === "focus_panel:detail")?.sequence,
    ).toEqual(["space", "p", "2"]);
    expect(
      keymap.bindings.find((binding) => binding.id === "focus_panel:frontier")?.sequence,
    ).toEqual(["space", "p", "3"]);
    expect(
      keymap.bindings.find((binding) => binding.id === "focus_panel:claims")?.sequence,
    ).toEqual(["space", "p", "4"]);
  });

  test("default exposes leader-key terminal toggle", () => {
    const keymap = resolveBuiltinKeymap("default");
    const binding = keymap.bindings.find(
      (candidate) => candidate.id === "toggle_panel:terminal" && candidate.preferred,
    );

    expect(binding).toBeDefined();
    expect(binding?.action).toBe("toggle_panel");
    expect(binding?.panel).toBe(Panel.Terminal);
    expect(binding?.sequence).toEqual(["space", "p", "t"]);
  });

  test("default does not bind terminal direct alias", () => {
    const keymap = resolveBuiltinKeymap("default");
    const result = resolveKeySequence(keymap.bindings, ["6"]);

    expect(result).toEqual({ kind: "miss" });
  });

  test("power-user includes leader and direct terminal bindings", () => {
    const keymap = resolveBuiltinKeymap("power-user");
    const leader = keymap.bindings.find(
      (candidate) => candidate.id === "toggle_panel:terminal" && candidate.preferred,
    );
    const direct = keymap.bindings.find(
      (candidate) =>
        candidate.id === "toggle_panel:terminal" &&
        candidate.sequence.length === 1 &&
        candidate.sequence[0] === "6",
    );

    expect(leader?.sequence).toEqual(["space", "p", "t"]);
    expect(direct?.sequence).toEqual(["6"]);
    expect(direct?.panel).toBe(Panel.Terminal);
  });

  test("power-user direct aliases are not preferred over leader bindings", () => {
    const keymap = resolveBuiltinKeymap("power-user");
    const leader = keymap.bindings.find(
      (candidate) => candidate.id === "toggle_panel:terminal" && candidate.preferred,
    );
    const direct = keymap.bindings.find(
      (candidate) =>
        candidate.id === "toggle_panel:terminal" &&
        candidate.sequence.length === 1 &&
        candidate.sequence[0] === "6",
    );

    expect(leader?.preferred).toBe(true);
    expect(direct?.preferred).toBe(false);
  });

  test("imported preset bindings use frozen normalized sequences and canonical panels", () => {
    const keymap = resolveBuiltinKeymap("power-user");
    const terminalBindings = keymap.bindings.filter(
      (binding) => binding.id === "toggle_panel:terminal",
    );

    expect(keymap.conflicts).toEqual([]);
    expect(terminalBindings.length).toBeGreaterThan(0);
    for (const binding of keymap.bindings) {
      expect(Object.isFrozen(binding.sequence)).toBe(true);
    }
    expect(terminalBindings.every((binding) => binding.panel === Panel.Terminal)).toBe(true);
  });

  test("power-user does not duplicate inherited bindings", () => {
    const keymap = resolveBuiltinKeymap("power-user");
    const seen = new Set<string>();

    for (const binding of keymap.bindings) {
      const key = `${binding.id}:${binding.sequence.join(" ")}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});
