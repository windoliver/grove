import { describe, expect, test } from "bun:test";
import type { Handoff } from "../core/handoff.js";
import {
  HandoffOperatorAction,
  type HandoffOperatorProjection,
  HandoffOperatorState,
} from "../core/handoff-operator-state.js";
import { performHandoffOperatorAction } from "./handoff-actions.js";
import type { ProviderCapabilities, TuiDataProvider } from "./provider.js";

const HANDOFFS_CAPABILITY: ProviderCapabilities = {
  outcomes: false,
  artifacts: false,
  vfs: false,
  messaging: false,
  costTracking: false,
  askUser: false,
  github: false,
  bounties: false,
  gossip: false,
  goals: false,
  sessions: false,
  handoffs: true,
  prompts: false,
};

function handoff(overrides?: Partial<Handoff>): Handoff {
  return {
    handoffId: "handoff-1",
    sourceCid: "blake3:source",
    fromRole: "coder",
    toRole: "reviewer",
    status: "delivered",
    requiresReply: true,
    createdAt: "2026-05-20T12:00:00.000Z",
    ...overrides,
  };
}

function projection(
  actions: readonly HandoffOperatorAction[],
  overrides?: Partial<Handoff>,
): HandoffOperatorProjection {
  return {
    handoff: handoff(overrides),
    state: HandoffOperatorState.Blocked,
    reason: "agent task failed",
    actions,
  };
}

describe("performHandoffOperatorAction", () => {
  test("passes reason and active session to terminal provider actions", async () => {
    const calls: unknown[][] = [];
    const provider = {
      capabilities: HANDOFFS_CAPABILITY,
      getHandoffs: async () => [],
      markHandoffDelivered: async () => undefined,
      cancelHandoff: async (...args: unknown[]) => {
        calls.push(["cancel", ...args]);
      },
      manualResolveHandoff: async (...args: unknown[]) => {
        calls.push(["manual", ...args]);
      },
      resendHandoff: async (...args: unknown[]) => {
        calls.push(["resend", ...args]);
      },
      rerouteHandoff: async (...args: unknown[]) => {
        calls.push(["reroute", ...args]);
      },
    } as unknown as TuiDataProvider;
    const blocked = projection([HandoffOperatorAction.Cancel, HandoffOperatorAction.ManualResolve]);

    await performHandoffOperatorAction({
      provider,
      projection: blocked,
      action: HandoffOperatorAction.Cancel,
      sessionId: "session-a",
      promptReason: async () => "operator stopped waiting",
      promptRerouteRole: async () => null,
    });
    await performHandoffOperatorAction({
      provider,
      projection: blocked,
      action: HandoffOperatorAction.ManualResolve,
      sessionId: "session-a",
      promptReason: async () => "handled out of band",
      promptRerouteRole: async () => null,
    });

    expect(calls).toEqual([
      ["cancel", "handoff-1", "operator stopped waiting", "session-a"],
      ["manual", "handoff-1", "handled out of band", "session-a"],
    ]);
  });

  test("prompts for reroute target role and preserves session scope", async () => {
    const calls: unknown[][] = [];
    const provider = {
      capabilities: HANDOFFS_CAPABILITY,
      getHandoffs: async () => [],
      markHandoffDelivered: async () => undefined,
      cancelHandoff: async () => undefined,
      manualResolveHandoff: async () => undefined,
      resendHandoff: async () => undefined,
      rerouteHandoff: async (...args: unknown[]) => {
        calls.push(args);
      },
    } as unknown as TuiDataProvider;

    const performed = await performHandoffOperatorAction({
      provider,
      projection: projection([HandoffOperatorAction.Reroute]),
      action: HandoffOperatorAction.Reroute,
      sessionId: "session-a",
      promptReason: async () => "needs a live reviewer",
      promptRerouteRole: async () => "auditor",
    });

    expect(performed).toBe(true);
    expect(calls).toEqual([
      [
        "handoff-1",
        {
          toRole: "auditor",
          reason: "needs a live reviewer",
          sessionId: "session-a",
        },
      ],
    ]);
  });

  test("does not call provider when action is unavailable or prompt is cancelled", async () => {
    const calls: unknown[][] = [];
    const provider = {
      capabilities: HANDOFFS_CAPABILITY,
      getHandoffs: async () => [],
      markHandoffDelivered: async () => undefined,
      cancelHandoff: async (...args: unknown[]) => {
        calls.push(args);
      },
      manualResolveHandoff: async () => undefined,
      resendHandoff: async () => undefined,
      rerouteHandoff: async () => undefined,
    } as unknown as TuiDataProvider;

    const unavailable = await performHandoffOperatorAction({
      provider,
      projection: projection([]),
      action: HandoffOperatorAction.Cancel,
      promptReason: async () => "unused",
      promptRerouteRole: async () => null,
    });
    const cancelled = await performHandoffOperatorAction({
      provider,
      projection: projection([HandoffOperatorAction.Cancel]),
      action: HandoffOperatorAction.Cancel,
      promptReason: async () => null,
      promptRerouteRole: async () => null,
    });

    expect(unavailable).toBe(false);
    expect(cancelled).toBe(false);
    expect(calls).toEqual([]);
  });
});
