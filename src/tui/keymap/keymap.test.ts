import { describe, expect, test } from "bun:test";
import {
  formatKeySequence,
  type KeyBinding,
  keyEventToToken,
  normalizeKeyToken,
  parseKeySequence,
  resolveKeySequence,
} from "./keymap.js";

function binding(
  id: string,
  sequence: readonly string[],
  action: KeyBinding["action"] = "help",
): KeyBinding {
  return {
    id,
    action,
    sequence,
    label: id,
    context: "global",
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

  test("normalizes individual tokens", () => {
    expect(normalizeKeyToken("Space")).toBe("space");
    expect(normalizeKeyToken("escape")).toBe("escape");
    expect(normalizeKeyToken("Ctrl+p")).toBe("ctrl+p");
  });

  test("converts key events into route tokens", () => {
    expect(keyEventToToken({ name: "space", ctrl: false })).toBe("space");
    expect(keyEventToToken({ name: "p", ctrl: true })).toBe("ctrl+p");
    expect(keyEventToToken({ name: "F5", ctrl: false })).toBe("F5");
  });
});

describe("resolveKeySequence", () => {
  const bindings: readonly KeyBinding[] = [
    binding("help", ["space", "?"]),
    binding("toggle_panel:terminal", ["space", "p", "t"], "toggle_panel"),
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

  test("direct sequence returns match", () => {
    const result = resolveKeySequence(bindings, ["r"]);
    expect(result.kind).toBe("match");
    if (result.kind === "match") expect(result.binding.id).toBe("refresh");
  });

  test("unknown sequence returns miss", () => {
    expect(resolveKeySequence(bindings, ["space", "x"])).toEqual({ kind: "miss" });
  });
});
