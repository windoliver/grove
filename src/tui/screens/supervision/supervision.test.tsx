/**
 * Component-level tests for the Supervision composition root (#193 Task 8).
 *
 * Covers:
 *   - auto-selects highest-priority (first) agent on mount
 *   - empty agents shows FleetRail empty state and DetailRail placeholder
 *   - controlled pinnedAgentId prop overrides default cursor selection
 *   - onSelect callback fires with the selected agentId on mount
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
const { Supervision } = await import("./supervision.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function agent(agentId: string, over: Partial<FleetAgent> = {}): FleetAgent {
  return {
    agentId,
    agentName: agentId,
    role: "coder",
    platform: "claude",
    session: undefined,
    claim: { spec: { targetRef: "t" } } as FleetAgent["claim"],
    health: { kind: "running" } as AgentHealth,
    currentTask: undefined,
    lastAction: undefined,
    lastOutputAt: undefined,
    cost: undefined,
    handoffs: { pendingOut: 0, overdueIn: 0 },
    pendingApproval: undefined,
    attemptCount: 0,
    ...over,
  };
}

describe("Supervision", () => {
  test("auto-selects highest-priority agent on mount (agents[0], here 'bad')", async () => {
    // buildFleet sorts problem-first; here we pass them already sorted, "bad" first
    const agents = [
      agent("bad", { agentName: "bad", health: { kind: "error", reason: "boom" } as AgentHealth }),
      agent("ok", { agentName: "ok", health: { kind: "running" } as AgentHealth }),
    ];
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (<Supervision agents={agents} tail={[]} />) as React.ReactElement,
      );
    });
    const flat = JSON.stringify(renderer.toJSON());
    // "bad" is agents[0], so it should be the selected agent shown in DetailRail
    expect(flat).toContain("bad");
    // DetailRail health header for error shows "ERROR: boom"
    expect(flat).toContain("ERROR: boom");
    renderer.unmount();
  });

  test("empty agents shows FleetRail empty state and DetailRail placeholder", async () => {
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create((<Supervision agents={[]} tail={[]} />) as React.ReactElement);
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("No agents registered");
    expect(flat).toContain("Select an agent");
    renderer.unmount();
  });

  test("controlled pinnedAgentId prop selects 'y' even though cursor defaults to 0/'x'", async () => {
    const agents = [agent("x", { agentName: "agent-x" }), agent("y", { agentName: "agent-y" })];
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (<Supervision agents={agents} tail={[]} pinnedAgentId="y" />) as React.ReactElement,
      );
    });
    const flat = JSON.stringify(renderer.toJSON());
    // DetailRail shows the agent name of the pinned agent
    expect(flat).toContain("agent-y");
    renderer.unmount();
  });

  test("onSelect is called with the selected agentId on mount", async () => {
    const received: Array<string | undefined> = [];
    const onSelect = (id: string | undefined): void => {
      received.push(id);
    };
    const agents = [agent("x", { agentName: "agent-x" })];
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (<Supervision agents={agents} tail={[]} onSelect={onSelect} />) as React.ReactElement,
      );
    });
    expect(received).toContain("x");
    renderer.unmount();
  });

  test("auto-select-on-approval: approval agent becomes selected in DetailRail", async () => {
    const runningAgents = [agent("x"), agent("y")];
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (<Supervision agents={runningAgents} tail={[]} />) as React.ReactElement,
      );
    });
    await act(async () => {
      renderer.update(
        (
          <Supervision
            agents={[
              agent("x"),
              agent("y", { health: { kind: "approval", cmd: "rm" } as AgentHealth }),
            ]}
            tail={[]}
          />
        ) as React.ReactElement,
      );
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("APPROVAL PENDING");
    renderer.unmount();
  });

  test("controlled cursor prop: cursor={1} selects second agent in DetailRail", async () => {
    const agents = [agent("x", { agentName: "agent-x" }), agent("y", { agentName: "agent-y" })];
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (<Supervision agents={agents} tail={[]} cursor={1} />) as React.ReactElement,
      );
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("agent-y");
    renderer.unmount();
  });

  test("pin precedence: pinnedAgentId='y' wins over cursor={0}", async () => {
    const agents = [agent("x", { agentName: "agent-x" }), agent("y", { agentName: "agent-y" })];
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <Supervision agents={agents} tail={[]} cursor={0} pinnedAgentId="y" />
        ) as React.ReactElement,
      );
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("agent-y");
    renderer.unmount();
  });
});
