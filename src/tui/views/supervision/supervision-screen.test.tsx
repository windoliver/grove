import { describe, expect, mock, test } from "bun:test";
import React from "react";
import type * as TestRendererTypes from "react-test-renderer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mock @opentui/react so useKeyboard is a no-op in tests
// ---------------------------------------------------------------------------
mock.module("@opentui/react", () => ({
  useKeyboard: (): void => undefined,
  useRenderer: (): { destroy: () => void } => ({ destroy: () => undefined }),
  useTerminalDimensions: (): { width: number; height: number } => ({ width: 120, height: 40 }),
  useTimeline: (): unknown => ({}),
  useOnResize: (): void => undefined,
  extend: (): void => undefined,
  flushSync: (fn: () => void): void => fn(),
  createRoot: (): unknown => ({}),
}));

// Import AFTER mock.module so the component picks up the mocked useKeyboard.
const TestRendererModule = await import("react-test-renderer");
const TestRenderer = (TestRendererModule as unknown as { default: typeof TestRendererTypes }).default;
const { act } = TestRendererModule;

const { ClaimStatus } = await import("../../../core/models.js");
const { makeAgent, makeClaim } = await import("../../../core/test-helpers.js");
const { SupervisionScreen } = await import("./supervision-screen.js");

import type { TuiDataProvider } from "../../provider.js";

function fakeProvider(claims: ReturnType<typeof makeClaim>[] = []): TuiDataProvider {
  return {
    capabilities: {} as never,
    getDashboard: async () => ({}) as never,
    getContributions: async () => [],
    getContribution: async () => undefined,
    getClaims: async () => claims,
    getFrontier: async () => ({}) as never,
    getActivity: async () => [],
    getDag: async () => ({ nodes: [], edges: [] }) as never,
    getHotThreads: async () => [],
    getSessionCosts: async () => ({ totalCostUsd: 0, totalTokens: 0, byAgent: [] }),
    close: () => {},
  } as unknown as TuiDataProvider;
}

async function sleep(ms: number) { await new Promise((r) => setTimeout(r, ms)); }

describe("SupervisionScreen", () => {
  test("renders empty state when no agents", async () => {
    let renderer: TestRendererTypes.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(SupervisionScreen, {
          provider: fakeProvider([]),
          intervalMs: 1000,
          pendingApprovals: [],
          onAcceptApproval: async () => {},
          onRejectApproval: async () => {},
        }),
      );
      await sleep(50);
    });
    expect(JSON.stringify(renderer!.toJSON())).toMatch(/No agents registered/);
    await act(async () => { renderer!.unmount(); });
  });

  test("renders grid when claims present", async () => {
    const claims = [
      makeClaim({
        agent: makeAgent({ agentId: "a-7a3" }),
        status: ClaimStatus.Active,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ];
    let renderer: TestRendererTypes.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(SupervisionScreen, {
          provider: fakeProvider(claims),
          intervalMs: 1000,
          pendingApprovals: [],
          onAcceptApproval: async () => {},
          onRejectApproval: async () => {},
        }),
      );
      await sleep(100);
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("a-7a3");
    await act(async () => { renderer!.unmount(); });
  });
});
