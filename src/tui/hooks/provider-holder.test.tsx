import { describe, expect, test } from "bun:test";
import React, { useState } from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { InformerFactory } from "../../core/informer.js";
import { createInformerHolder, InformerProviderHolder } from "./informer-context.js";
import { RefreshProviderHolder } from "./refresh-context.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeFactory(): InformerFactory {
  return {
    mode: "local",
    supportsKind: () => true,
    startAll: () => undefined,
    stopAll: async () => undefined,
    relist: async () => undefined,
  } as unknown as InformerFactory;
}

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

function StatefulChild(): React.ReactNode {
  const [label, setLabel] = useState("before");
  return React.createElement(
    "box",
    null,
    React.createElement("text", null, label),
    React.createElement("button", { type: "button", onClick: () => setLabel("kept") }),
  );
}

describe("async provider holders", () => {
  test("InformerProviderHolder does not remount children when factory arrives", () => {
    const holder = createInformerHolder();
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    act(() => {
      renderer = TestRenderer.create(
        React.createElement(InformerProviderHolder, { holder }, React.createElement(StatefulChild)),
      );
    });
    if (!renderer) throw new Error("renderer did not mount");

    const button = renderer.root.findByType("button");
    act(() => {
      button.props.onClick();
    });
    expect(collectText(renderer.toJSON())).toContain("kept");

    act(() => {
      holder.set(makeFactory());
    });

    expect(collectText(renderer.toJSON())).toContain("kept");
  });

  test("RefreshProviderHolder does not remount children when factory arrives", () => {
    const holder = createInformerHolder();
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    act(() => {
      renderer = TestRenderer.create(
        React.createElement(RefreshProviderHolder, { holder }, React.createElement(StatefulChild)),
      );
    });
    if (!renderer) throw new Error("renderer did not mount");

    const button = renderer.root.findByType("button");
    act(() => {
      button.props.onClick();
    });
    expect(collectText(renderer.toJSON())).toContain("kept");

    act(() => {
      holder.set(makeFactory());
    });

    expect(collectText(renderer.toJSON())).toContain("kept");
  });
});
