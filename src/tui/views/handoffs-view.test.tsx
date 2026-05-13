import { describe, expect, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { type Handoff, HandoffStatus } from "../../core/handoff.js";
import type { TuiDataProvider } from "../provider.js";
import { HandoffsView } from "./handoffs-view.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function collectText(
  node: TestRenderer.ReactTestRendererJSON | TestRenderer.ReactTestRendererJSON[] | null,
): string {
  if (!node) return "";
  if (Array.isArray(node)) return node.map((child) => collectText(child)).join("");
  return (
    node.children
      ?.map((child) => (typeof child === "string" ? child : collectText(child)))
      .join("") ?? ""
  );
}

describe("HandoffsView", () => {
  test("renders replied handoffs as operator-visible done state", () => {
    const provider = {
      getHandoffs: async () => [],
      markHandoffDelivered: async () => undefined,
    } as unknown as TuiDataProvider;
    const handoff: Handoff = {
      handoffId: "handoff-1",
      sourceCid: "blake3:a913b2e46abcdef",
      fromRole: "coder",
      toRole: "reviewer",
      status: HandoffStatus.Replied,
      requiresReply: true,
      replyDueAt: "2026-05-07T20:00:00.000Z",
      resolvedByCid: "blake3:review",
      createdAt: "2026-05-07T19:59:00.000Z",
    };
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    act(() => {
      renderer = TestRenderer.create(
        React.createElement(HandoffsView, {
          provider,
          active: true,
          cursor: 0,
          handoffs: [handoff],
        }),
      );
    });
    if (!renderer) throw new Error("renderer did not mount");

    const text = collectText(renderer.toJSON());
    expect(text).toContain("[done]");
    expect(text).toContain("met");
  });
});
