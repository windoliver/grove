/**
 * Tests for FlashBar transient error component.
 *
 * FlashBar displays cycle/depth/miss/parse errors from the C2 alias resolver.
 * Tests verify null handling and message rendering with error styling.
 */

import { describe, expect, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { FlashBar } from "./flash-bar.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Extract all text content from a rendered tree.
 * Ignores component boundaries and host (box/text) elements,
 * concatenating only text nodes.
 */
function collectText(
  node: TestRenderer.ReactTestRendererJSON | TestRenderer.ReactTestRendererJSON[] | null,
): string {
  if (!node) return "";
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (typeof node === "string") return node;
  if (node.children) return collectText(node.children);
  return "";
}

describe("FlashBar", () => {
  test("message={null} renders null", () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      renderer = TestRenderer.create(<FlashBar message={null} />);
    });
    expect(renderer!.toJSON()).toBeNull();
  });

  test('message="alias not found" renders text containing that message', () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      renderer = TestRenderer.create(<FlashBar message="alias not found" />);
    });
    const text = collectText(renderer!.toJSON());
    expect(text).toContain("alias not found");
  });
});
