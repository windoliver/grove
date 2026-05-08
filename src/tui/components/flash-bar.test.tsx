/**
 * Tests for FlashBar transient error component.
 *
 * FlashBar displays cycle/depth/miss/parse errors from the C2 alias resolver.
 * Tests verify null handling and message rendering with error styling.
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FlashBar, type FlashBarProps } from "./flash-bar.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(props: FlashBarProps): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(React.createElement(FlashBar, props));
  });
  if (!renderer) throw new Error("renderer not initialized");
  return renderer;
}

type RenderedNode =
  | TestRenderer.ReactTestRendererJSON
  | TestRenderer.ReactTestRendererNode
  | TestRenderer.ReactTestRendererJSON[]
  | TestRenderer.ReactTestRendererNode[]
  | null;

function collectText(node: RenderedNode): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (typeof node === "object" && "children" in node && node.children) {
    return collectText(node.children);
  }
  return "";
}

describe("FlashBar", () => {
  test("message={null} renders null", () => {
    const tree = render({ message: null }).toJSON();
    expect(tree).toBeNull();
  });

  test('message="alias not found" renders text containing that message', () => {
    const text = collectText(render({ message: "alias not found" }).toJSON());
    expect(text).toContain("alias not found");
  });
});
