/**
 * Tests for the <Prompt> component.
 *
 * Uses react-test-renderer because OpenTUI's custom hosts (<box>, <text>)
 * aren't DOM nodes — react-test-renderer ignores hosts and only exercises
 * component logic, which is exactly what we need here.
 *
 * Components are constructed via React.createElement (not JSX) to match the
 * repo's existing test pattern; React.memo's NamedExoticComponent typing
 * returns ReactNode, which doesn't satisfy TestRenderer.create's stricter
 * ReactElement parameter.
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Prompt, type PromptProps } from "./prompt.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(props: PromptProps): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(React.createElement(Prompt, props));
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

describe("Prompt", () => {
  test("renders nothing when mode is none", () => {
    const tree = render({ mode: "none", query: "" }).toJSON();
    expect(tree).toBeNull();
  });

  test("renders ':query' in goto mode", () => {
    const text = collectText(render({ mode: "goto", query: "ag" }).toJSON());
    expect(text).toContain(":");
    expect(text).toContain("ag");
  });

  test("renders '/query' in filter mode", () => {
    const text = collectText(render({ mode: "filter", query: "foo" }).toJSON());
    expect(text).toContain("/");
    expect(text).toContain("foo");
  });

  test("dropdown shows when suggestions.length > 1", () => {
    const text = collectText(
      render({
        mode: "goto",
        query: "a",
        suggestions: ["a", "agents-only", "admin"],
        suggestionIndex: 1,
      }).toJSON(),
    );
    expect(text).toContain("agents-only");
    expect(text).toContain("admin");
  });

  test("dropdown hidden when only one suggestion", () => {
    const text = collectText(
      render({
        mode: "goto",
        query: "ag",
        suggestions: ["agents-only"],
        suggestionIndex: 0,
      }).toJSON(),
    );
    expect(text).not.toContain("admin");
  });

  test("error prop renders error text", () => {
    const text = collectText(
      render({ mode: "goto", query: "bad", error: "alias not found" }).toJSON(),
    );
    expect(text).toContain("alias not found");
  });
});
