/**
 * Renders SupervisionScreen against a 12-agent fixture and confirms the
 * fleet banner and cards are populated.
 */

import { describe, expect, mock, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { ClaimStatus, ContributionKind } from "../../src/core/models.js";
import { makeAgent, makeClaim, makeContribution } from "../../src/core/test-helpers.js";
import type { TuiDataProvider } from "../../src/tui/provider.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// useKeyboard from @opentui/react does heavy native work outside a real
// terminal; stub it so react-test-renderer can mount the screen.
mock.module("@opentui/react", () => ({ useKeyboard: (): void => undefined }));

const { SupervisionScreen } = await import("../../src/tui/views/supervision/supervision-screen.js");

const NOW = Date.now();

function fixture12() {
  const claims = [];
  const contribs = [];
  for (let i = 0; i < 12; i++) {
    const id = `a-${(i + 1).toString().padStart(3, "0")}`;
    claims.push(
      makeClaim({
        agent: makeAgent({ agentId: id, role: i % 2 === 0 ? "coder" : "reviewer" }),
        status: ClaimStatus.Active,
        leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
        targetRef: `task-${id}`,
      }),
    );
    contribs.push(
      makeContribution({
        agent: makeAgent({ agentId: id }),
        kind: ContributionKind.Work,
        createdAt: new Date(NOW - 10_000).toISOString(),
      }),
    );
  }
  const provider: TuiDataProvider = {
    capabilities: {} as never,
    getDashboard: async (): Promise<never> => ({}) as never,
    getClaims: async () => claims,
    getContributions: async () => contribs,
    getContribution: async () => undefined,
    getFrontier: async (): Promise<never> => ({}) as never,
    getActivity: async () => [],
    getDag: async () => ({ nodes: [], edges: [] }) as never,
    getHotThreads: async () => [],
    getSessionCosts: async () => ({ totalCostUsd: 0, totalTokens: 0, byAgent: [] }),
    close: (): void => undefined,
  } as unknown as TuiDataProvider;
  return { claims, contribs, provider };
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

describe("SupervisionScreen 12-agent snapshot", () => {
  test("renders FLEET banner and all 12 agent cards", async () => {
    const { provider } = fixture12();
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(SupervisionScreen, {
          provider,
          intervalMs: 1000,
          pendingApprovals: [],
          onAcceptApproval: async (): Promise<void> => undefined,
          onRejectApproval: async (): Promise<void> => undefined,
        }),
      );
      await sleep(200);
    });
    const s = JSON.stringify(renderer!.toJSON());
    expect(s).toContain("FLEET");
    for (let i = 1; i <= 12; i++) {
      const id = `a-${i.toString().padStart(3, "0")}`;
      expect(s).toContain(id);
    }
    await act(async () => {
      renderer!.unmount();
    });
  });
});
