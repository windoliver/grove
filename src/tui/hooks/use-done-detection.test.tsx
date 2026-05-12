import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { LocalEventBus } from "../../core/local-event-bus.js";
import type { AgentTopology } from "../../core/topology.js";
import type { Screen } from "../screens/screen-manager.js";
import { useDoneDetection } from "./use-done-detection.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REVIEW_LOOP_TOPOLOGY: AgentTopology = {
  structure: "graph",
  roles: [
    {
      name: "coder",
      edges: [{ target: "reviewer", edgeType: "delegates" }],
    },
    {
      name: "reviewer",
    },
  ],
};

const mountedRenderers: TestRenderer.ReactTestRenderer[] = [];
const openBuses: LocalEventBus[] = [];

function Probe({
  topology,
  screen,
  eventBus,
  onDone,
}: {
  readonly topology: AgentTopology;
  readonly screen: Screen;
  readonly eventBus: LocalEventBus;
  readonly onDone: () => void;
}): null {
  useDoneDetection(topology, screen, eventBus, onDone);
  return null;
}

afterEach(() => {
  for (const renderer of mountedRenderers.splice(0)) {
    act(() => {
      renderer.unmount();
    });
  }
  for (const bus of openBuses.splice(0)) {
    bus.close();
  }
});

describe("useDoneDetection", () => {
  test("completes the session when the reviewer signals done", async () => {
    const bus = new LocalEventBus();
    openBuses.push(bus);

    let doneCalls = 0;
    await act(async () => {
      mountedRenderers.push(
        TestRenderer.create(
          React.createElement(Probe, {
            topology: REVIEW_LOOP_TOPOLOGY,
            screen: "running",
            eventBus: bus,
            onDone: () => {
              doneCalls += 1;
            },
          }),
        ),
      );
    });

    await act(async () => {
      await bus.publish({
        type: "contribution",
        sourceRole: "reviewer",
        targetRole: "reviewer",
        payload: {
          summary: "[DONE] Approved",
          context: { done: true },
        },
        timestamp: "2026-05-07T00:00:00.000Z",
      });
    });

    expect(doneCalls).toBe(1);
  });

  test("uses explicit session-ending roles before terminal-role fallback", async () => {
    const bus = new LocalEventBus();
    openBuses.push(bus);
    const topology: AgentTopology = {
      structure: "graph",
      roles: [
        {
          name: "coder",
          endsSession: true,
          edges: [{ target: "reviewer", edgeType: "delegates" }],
        },
        {
          name: "reviewer",
        },
      ],
    };

    let doneCalls = 0;
    await act(async () => {
      mountedRenderers.push(
        TestRenderer.create(
          React.createElement(Probe, {
            topology,
            screen: "running",
            eventBus: bus,
            onDone: () => {
              doneCalls += 1;
            },
          }),
        ),
      );
    });

    await act(async () => {
      await bus.publish({
        type: "contribution",
        sourceRole: "reviewer",
        targetRole: "reviewer",
        payload: {
          summary: "[DONE] Reviewer done",
          context: { done: true },
        },
        timestamp: "2026-05-07T00:00:00.000Z",
      });
    });
    expect(doneCalls).toBe(0);

    await act(async () => {
      await bus.publish({
        type: "contribution",
        sourceRole: "coder",
        targetRole: "coder",
        payload: {
          summary: "[DONE] Coder done",
          context: { done: true },
        },
        timestamp: "2026-05-07T00:00:01.000Z",
      });
    });
    expect(doneCalls).toBe(1);
  });
});
