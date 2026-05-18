/**
 * Component-level tests for the DetailRail selected-agent context (#193 Task 6).
 *
 * Covers:
 *   - agent={undefined} → shows "Select an agent"
 *   - base agent with tail → shows name, task, cost, pending handoffs, tail line
 *   - approval agent → shows command and [y]allow prompt
 */

import { describe, expect, mock, test } from "bun:test";
import type React from "react";
import type * as TestRendererTypes from "react-test-renderer";
import type { AgentHealth } from "./agent-health.js";
import type { FleetAgent } from "./use-fleet-model.js";

mock.module("@opentui/react", () => ({
  useKeyboard: (): void => undefined,
  useRenderer: (): { destroy: () => void } => ({ destroy: () => undefined }),
  useTerminalDimensions: (): { width: number; height: number } => ({ width: 120, height: 40 }),
  useTimeline: (): unknown => ({}),
  useOnResize: (): void => undefined,
  useAppContext: (): unknown => ({}),
  createPortal: (children: unknown): unknown => children,
  createRoot: (): unknown => ({}),
  createElement: (): unknown => null,
  flushSync: (fn: () => void): void => fn(),
  extend: (): void => undefined,
  getComponentCatalogue: (): unknown => ({}),
  componentCatalogue: {},
  baseComponents: {},
  TimeToFirstDraw: (): null => null,
  AppContext: {},
}));

const TestRendererModule = await import("react-test-renderer");
const TestRenderer = (TestRendererModule as unknown as { default: typeof TestRendererTypes })
  .default;
const { act } = TestRendererModule;
const { DetailRail } = await import("./detail-rail.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function agent(over: Partial<FleetAgent>): FleetAgent {
  return {
    agentId: "a1",
    agentName: "alpha",
    role: "coder",
    platform: "claude",
    session: "grove-coder-x",
    claim: { spec: { targetRef: "t" } } as FleetAgent["claim"],
    health: { kind: "running" } as AgentHealth,
    currentTask: "edit login.ts",
    lastAction: undefined,
    lastOutputAt: undefined,
    cost: { usd: 1.18, tokens: 42000 },
    handoffs: { pendingOut: 1, overdueIn: 0 },
    pendingApproval: undefined,
    attemptCount: 0,
    ...over,
  };
}

describe("DetailRail", () => {
  test("agent=undefined shows Select an agent prompt", async () => {
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (<DetailRail agent={undefined} tail={[]} />) as React.ReactElement,
      );
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("Select an agent");
    renderer.unmount();
  });

  test("base agent with tail shows name, task, cost, handoffs, and tail lines", async () => {
    const a = agent({});
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (<DetailRail agent={a} tail={["line 1", "line 2"]} />) as React.ReactElement,
      );
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("alpha");
    expect(flat).toContain("edit login.ts");
    expect(flat).toContain("$1.18");
    expect(flat).toContain("1 pending out");
    expect(flat).toContain("line 2");
    renderer.unmount();
  });

  test("base agent with no targetRef shows 'target: -'", async () => {
    const a = agent({
      claim: { spec: {} } as FleetAgent["claim"],
    });
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create((<DetailRail agent={a} tail={[]} />) as React.ReactElement);
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("target: ");
    expect(flat).toContain('"-"');
    renderer.unmount();
  });

  test("approval agent shows command and [y]allow prompt", async () => {
    const a = agent({
      health: { kind: "approval", cmd: "rm -rf foo" } as AgentHealth,
      pendingApproval: { sessionName: "s", agentRole: "coder", command: "rm -rf foo" },
    });
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create((<DetailRail agent={a} tail={[]} />) as React.ReactElement);
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("rm -rf foo");
    expect(flat).toContain("[y]allow");
    expect(flat).toContain("[a]always");
    expect(flat).toContain("[n]deny");
    renderer.unmount();
  });

  test("overdueIn branch shows overdue count", async () => {
    const a = agent({ handoffs: { pendingOut: 0, overdueIn: 2 } });
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create((<DetailRail agent={a} tail={[]} />) as React.ReactElement);
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("2 overdue in");
    renderer.unmount();
  });

  test("cost undefined branch renders dash", async () => {
    const a = agent({ cost: undefined });
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create((<DetailRail agent={a} tail={[]} />) as React.ReactElement);
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("Cost");
    expect(flat).toContain('"-"');
    renderer.unmount();
  });

  test("blockedOn branch shows blocked-on label", async () => {
    const a = agent({ handoffs: { pendingOut: 0, overdueIn: 0, blockedOn: "coordinator" } });
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create((<DetailRail agent={a} tail={[]} />) as React.ReactElement);
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("blocked on coordinator");
    renderer.unmount();
  });
});
