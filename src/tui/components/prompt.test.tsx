/**
 * Tests for the <Prompt> component.
 *
 * Uses react-test-renderer because OpenTUI's custom hosts (<box>, <text>)
 * aren't DOM nodes — react-test-renderer ignores hosts and only exercises
 * component logic, which is exactly what we need here.
 */

import { describe, expect, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { Prompt } from "./prompt.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function collectText(
  node: TestRenderer.ReactTestRendererJSON | TestRenderer.ReactTestRendererJSON[] | null,
): string {
  if (!node) return "";
  if (Array.isArray(node)) return node.map(collectText).join("");
  return node.children?.map((c) => (typeof c === "string" ? c : collectText(c))).join("") ?? "";
}

describe("Prompt", () => {
  test("renders nothing when mode is none", () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      renderer = TestRenderer.create(<Prompt mode="none" query="" />);
    });
    const tree = renderer!.toJSON();
    expect(tree).toBeNull();
  });

  test("renders ':query' in goto mode", () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      renderer = TestRenderer.create(<Prompt mode="goto" query="ag" />);
    });
    const text = collectText(renderer!.toJSON());
    expect(text).toContain(":");
    expect(text).toContain("ag");
  });

  test("renders '/query' in filter mode", () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      renderer = TestRenderer.create(<Prompt mode="filter" query="foo" />);
    });
    const text = collectText(renderer!.toJSON());
    expect(text).toContain("/");
    expect(text).toContain("foo");
  });

  test("dropdown shows when suggestions.length > 1", () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      renderer = TestRenderer.create(
        <Prompt
          mode="goto"
          query="a"
          suggestions={["a", "agents-only", "admin"]}
          suggestionIndex={1}
        />,
      );
    });
    const text = collectText(renderer!.toJSON());
    expect(text).toContain("agents-only");
    expect(text).toContain("admin");
  });

  test("dropdown hidden when only one suggestion", () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      renderer = TestRenderer.create(
        <Prompt mode="goto" query="ag" suggestions={["agents-only"]} suggestionIndex={0} />,
      );
    });
    const text = collectText(renderer!.toJSON());
    expect(text).not.toContain("admin");
  });

  test("error prop renders error text", () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      renderer = TestRenderer.create(<Prompt mode="goto" query="bad" error="alias not found" />);
    });
    expect(collectText(renderer!.toJSON())).toContain("alias not found");
  });
});
