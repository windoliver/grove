import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { AgentTopology } from "../../core/topology.js";

type KeyboardKey = {
  readonly name?: string | undefined;
  readonly sequence?: string | undefined;
};

type KeyboardHandler = (key: KeyboardKey) => void;

let keyboardHandler: KeyboardHandler | undefined;
const mountedRenderers: TestRenderer.ReactTestRenderer[] = [];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module("@opentui/react", () => ({
  useKeyboard: (handler: KeyboardHandler): void => {
    keyboardHandler = handler;
  },
  useRenderer: (): { destroy: () => void } => ({
    destroy: () => undefined,
  }),
  useTerminalDimensions: (): { width: number; height: number } => ({
    width: 120,
    height: 40,
  }),
  useTimeline: (): { add: () => unknown; play: () => unknown } => ({
    add: () => ({ add: () => ({ play: () => undefined }), play: () => undefined }),
    play: () => undefined,
  }),
}));

mock.module("./agent-cli-detect.js", () => ({
  detectCli: () => true,
}));

mock.module("../layout/graph-layout.js", () => ({
  layoutGraph: () => ({ nodes: [], edges: [] }),
}));

mock.module("../layout/edge-render.js", () => ({
  renderGraph: () => ({ lines: [] }),
}));

const { AgentDetect } = await import("./agent-detect.js");

const TEST_TOPOLOGY: AgentTopology = {
  structure: "flat",
  roles: [{ name: "planner", skills: ["grove"] }, { name: "builder" }],
  spawning: { dynamic: false },
};

beforeEach(() => {
  keyboardHandler = undefined;
});

afterEach(async () => {
  await act(async () => {
    for (const renderer of mountedRenderers.splice(0)) {
      renderer.unmount();
    }
    await flushAsync();
  });
});

async function flushAsync(ms: number = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("AgentDetect launch preview", () => {
  test("launch submits initialized role skills for all roles", async () => {
    let capturedRoleSkills: Map<string, readonly string[]> | undefined;
    const onContinue = (
      _detected: Map<string, boolean>,
      _roleMapping: Map<string, string>,
      _rolePrompts: Map<string, string>,
      _edgeTimeouts: Map<string, number>,
      roleSkills: Map<string, readonly string[]>,
    ): void => {
      capturedRoleSkills = roleSkills;
    };

    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(AgentDetect, {
          topology: TEST_TOPOLOGY,
          onContinue,
          onBack: () => undefined,
        }),
      );
      await flushAsync();
    });

    if (!renderer) {
      throw new Error("AgentDetect did not mount");
    }
    mountedRenderers.push(renderer);

    const handler = keyboardHandler;
    if (!handler) {
      throw new Error("No keyboard handler registered");
    }

    await act(async () => {
      handler({ name: "return" });
      await flushAsync();
    });

    expect(capturedRoleSkills).toEqual(
      new Map<string, readonly string[]>([
        ["planner", ["grove"]],
        ["builder", []],
      ]),
    );
  });
});
