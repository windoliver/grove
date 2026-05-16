import { describe, expect, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { theme } from "../../theme.js";
import { AgentCard, CARD_HEIGHT, CARD_WIDTH } from "./agent-card.js";
import type { SupervisedAgent } from "./types.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeSupervised(over: Partial<SupervisedAgent> = {}): SupervisedAgent {
  return {
    agentId: "a-test-12345",
    role: "coder",
    platform: "claude",
    state: "running",
    stateReason: "last 5s",
    lastActionAt: 0,
    costUsd: 0.42,
    tokens: 0,
    contribCount: 1,
    costSpike: false,
    contextHot: false,
    contextPercent: 73,
    ...over,
  };
}

async function renderCard(agent: SupervisedAgent, focused: boolean) {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(AgentCard, { agent, focused }));
  });
  return renderer!;
}

describe("AgentCard dimensions", () => {
  test("fixed CARD_WIDTH and CARD_HEIGHT", () => {
    expect(CARD_WIDTH).toBe(26);
    expect(CARD_HEIGHT).toBe(6);
  });
});

describe("AgentCard state badges", () => {
  const STATES: SupervisedAgent["state"][] = [
    "running",
    "silent",
    "stuck",
    "thrashing",
    "blocked",
    "awaiting",
    "done",
    "idle",
  ];
  for (const state of STATES) {
    test(`renders state ${state} (smoke)`, async () => {
      const renderer = await renderCard(makeSupervised({ state }), false);
      const json = renderer.toJSON();
      expect(json).not.toBeNull();
      await act(async () => {
        renderer.unmount();
      });
    });
  }
});

describe("AgentCard styling", () => {
  test("focused card uses info border color", async () => {
    const renderer = await renderCard(makeSupervised(), true);
    const serialized = JSON.stringify(renderer.toJSON());
    expect(serialized).toContain(theme.info);
    await act(async () => {
      renderer.unmount();
    });
  });

  test("unfocused card uses secondary border color", async () => {
    const renderer = await renderCard(makeSupervised(), false);
    const serialized = JSON.stringify(renderer.toJSON());
    expect(serialized).toContain(theme.secondary);
    await act(async () => {
      renderer.unmount();
    });
  });

  test("contextHot agent has error color attached somewhere", async () => {
    const renderer = await renderCard(makeSupervised({ contextHot: true }), false);
    const serialized = JSON.stringify(renderer.toJSON());
    expect(serialized).toContain(theme.error);
    await act(async () => {
      renderer.unmount();
    });
  });

  test("costSpike adds a warning marker in the bottom row", async () => {
    const renderer = await renderCard(makeSupervised({ costSpike: true }), false);
    const serialized = JSON.stringify(renderer.toJSON());
    expect(serialized).toContain("⚠");
    await act(async () => {
      renderer.unmount();
    });
  });
});
