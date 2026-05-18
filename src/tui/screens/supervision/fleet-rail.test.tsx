/**
 * Component-level tests for the FleetRail dense lane list (#193 Task 5).
 *
 * Covers:
 *   - renders one row per fleet agent, both running and blocked appear
 *   - approval agent row contains "[y/n]"
 *   - empty agents array shows "No agents registered"
 *   - header shows agent count and problem count
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
const { FleetRail } = await import("./fleet-rail.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function agent(over: Partial<FleetAgent>): FleetAgent {
  return {
    agentId: "a",
    agentName: "agent-a",
    role: "coder",
    platform: "claude",
    session: undefined,
    claim: {} as FleetAgent["claim"],
    health: { kind: "running" } as AgentHealth,
    currentTask: "do thing",
    lastAction: undefined,
    lastOutputAt: undefined,
    cost: undefined,
    handoffs: { pendingOut: 0, overdueIn: 0 },
    pendingApproval: undefined,
    attemptCount: 0,
    ...over,
  };
}

describe("FleetRail", () => {
  test("renders one row per fleet agent; running and blocked agents appear with BLOCKED label", async () => {
    const agents = [
      agent({ agentId: "a1", agentName: "a1", health: { kind: "running" } }),
      agent({
        agentId: "a2",
        agentName: "a2",
        health: { kind: "blocked", on: "coord", sinceMs: 120_000 },
      }),
    ];
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <FleetRail agents={agents} cursor={0} selectedAgentId={undefined} />
        ) as React.ReactElement,
      );
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("a1");
    expect(flat).toContain("a2");
    expect(flat).toContain("BLOCKED");
    renderer.unmount();
  });

  test("approval agent row contains [y/n]", async () => {
    const agents = [
      agent({
        agentId: "a3",
        agentName: "a3",
        health: { kind: "approval", cmd: "rm" },
      }),
    ];
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <FleetRail agents={agents} cursor={0} selectedAgentId={undefined} />
        ) as React.ReactElement,
      );
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("[y/n]");
    renderer.unmount();
  });

  test("empty agents array shows No agents registered", async () => {
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (<FleetRail agents={[]} cursor={0} selectedAgentId={undefined} />) as React.ReactElement,
      );
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("No agents registered");
    renderer.unmount();
  });

  test("header with 2 agents where 1 is a problem shows count and 1 problem", async () => {
    const agents = [
      agent({ agentId: "b1", agentName: "b1", health: { kind: "running" } }),
      agent({ agentId: "b2", agentName: "b2", health: { kind: "stuck", sinceMs: 540_000 } }),
    ];
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <FleetRail agents={agents} cursor={0} selectedAgentId={undefined} />
        ) as React.ReactElement,
      );
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("2");
    expect(flat).toContain("1 problem");
    renderer.unmount();
  });
});
