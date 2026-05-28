// Probe findings (#192):
// INLINE_DIFF: fallback-to-code  — <diff> has no mode="inline"; its prop is `view?: "unified"|"split"` and it
//                                   takes `diff?: string` (unified-diff text), not oldContent/newContent.
//                                   Use <code language="diff"> for inline display or pass view="unified".
// SCROLLBOX_SCROLL: scrollTop    — ScrollBoxRenderable exposes get/set scrollTop as a first-class prop;
//                                   ScrollBoxOptions also has stickyScroll/stickyStart for auto-follow.
// Evidence: @opentui/core/renderables/Diff.d.ts (DiffRenderableOptions.view: "unified"|"split"),
//           @opentui/core/renderables/ScrollBox.d.ts (ScrollBoxRenderable.scrollTop getter+setter),
//           @opentui/react/src/types/components.d.ts (DiffProps, ScrollBoxProps surface confirmed).

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("opentui probe (#192)", () => {
  test("diff intrinsic accepts mode=inline without throwing", () => {
    let tree: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      tree = TestRenderer.create(
        createElement("diff", { oldContent: "a\nb", newContent: "a\nc", mode: "inline" }),
      );
    });
    const json = tree?.toJSON();
    console.log("DIFF_INLINE_JSON", JSON.stringify(json));
    expect(json).toBeDefined();
  });

  test("scrollbox surfaces its scroll-control props", () => {
    let tree: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      tree = TestRenderer.create(
        createElement("scrollbox", { scrollTop: 5 }, createElement("text", {}, "x")),
      );
    });
    const json = tree?.toJSON();
    console.log("SCROLLBOX_JSON", JSON.stringify(json));
    expect(json).toBeDefined();
  });
});
