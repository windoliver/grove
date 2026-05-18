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

  test("filterRole scopes rows to touching role; omitting prop shows all", () => {
    const provider = {
      getHandoffs: async () => [],
      markHandoffDelivered: async () => undefined,
    } as unknown as TuiDataProvider;

    const coderHandoff: Handoff = {
      handoffId: "handoff-coder",
      sourceCid: "blake3:coder001",
      fromRole: "coder",
      toRole: "reviewer",
      status: HandoffStatus.PendingPickup,
      requiresReply: false,
      createdAt: "2026-05-07T19:00:00.000Z",
    };
    const plannerHandoff: Handoff = {
      handoffId: "handoff-planner",
      sourceCid: "blake3:planner001",
      fromRole: "planner",
      toRole: "reviewer",
      status: HandoffStatus.Delivered,
      requiresReply: false,
      createdAt: "2026-05-07T19:01:00.000Z",
    };

    // --- With filterRole="coder": only coder-touching handoff appears ---
    let filteredRenderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      filteredRenderer = TestRenderer.create(
        React.createElement(HandoffsView, {
          provider,
          active: true,
          cursor: 0,
          handoffs: [coderHandoff, plannerHandoff],
          filterRole: "coder",
        }),
      );
    });
    if (!filteredRenderer) throw new Error("filteredRenderer did not mount");
    const filteredText = collectText(filteredRenderer.toJSON());
    expect(filteredText).toContain("coder");
    expect(filteredText).not.toContain("planner");
    filteredRenderer.unmount();

    // --- Without filterRole: both handoffs appear ---
    let allRenderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      allRenderer = TestRenderer.create(
        React.createElement(HandoffsView, {
          provider,
          active: true,
          cursor: 0,
          handoffs: [coderHandoff, plannerHandoff],
        }),
      );
    });
    if (!allRenderer) throw new Error("allRenderer did not mount");
    const allText = collectText(allRenderer.toJSON());
    expect(allText).toContain("coder");
    expect(allText).toContain("planner");
    allRenderer.unmount();
  });
});
