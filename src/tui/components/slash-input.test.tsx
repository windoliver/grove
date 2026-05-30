// src/tui/components/slash-input.test.tsx
import { describe, expect, test } from "bun:test";
import React from "react";
import TestRenderer, { act as testAct } from "react-test-renderer";
import { SlashInput } from "./slash-input.js";

// ---------------------------------------------------------------------------
// Render helpers (mirrors the collector used in command-palette.test.tsx)
// ---------------------------------------------------------------------------

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function allText(node: TestRenderer.ReactTestRendererJSON | null): string {
  if (node === null) return "";
  const parts: string[] = [];
  const walk = (n: TestRenderer.ReactTestRendererJSON | string): void => {
    if (typeof n === "string") {
      parts.push(n);
      return;
    }
    for (const child of n.children ?? []) {
      walk(child as TestRenderer.ReactTestRendererJSON | string);
    }
  };
  walk(node);
  return parts.join("");
}

function render(props: {
  visible: boolean;
  buffer: string;
  error?: string;
}): TestRenderer.ReactTestRendererJSON | null {
  let renderer!: TestRenderer.ReactTestRenderer;
  testAct(() => {
    renderer = TestRenderer.create(
      React.createElement(SlashInput, {
        visible: props.visible,
        buffer: props.buffer,
        error: props.error,
      }),
    );
  });
  const json = renderer.toJSON();
  renderer.unmount();
  if (Array.isArray(json)) throw new Error("unexpected render output");
  return json;
}

describe("SlashInput", () => {
  test("renders null (no ':' prompt) when not visible", () => {
    const json = render({ visible: false, buffer: "skill foo" });
    expect(json).toBeNull();
    expect(allText(json)).toBe("");
  });

  test("renders the ':' prompt and the buffer text when visible", () => {
    const json = render({ visible: true, buffer: "skill foo" });
    const text = allText(json);
    expect(text).toContain(":");
    expect(text).toContain("skill foo");
  });

  test("renders the error text when error is set", () => {
    const json = render({ visible: true, buffer: "nope", error: "Unknown command: /nope" });
    const text = allText(json);
    expect(text).toContain("Unknown command: /nope");
  });

  test("does not render error text when error is undefined", () => {
    const json = render({ visible: true, buffer: "quit" });
    const text = allText(json);
    expect(text).not.toContain("Unknown command");
  });
});
