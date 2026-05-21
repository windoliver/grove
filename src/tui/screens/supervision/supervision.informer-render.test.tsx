/**
 * Full-component mount integration: <Supervision> renders a POPULATED fleet
 * driven entirely by the production informer data path (#193 proof boundary).
 *
 * Unlike use-fleet-model.mount.test.tsx (which asserts the *hook* return),
 * this test composes useFleetModel + <Supervision> in one wrapper and
 * asserts the rendered tree (FleetRail + DetailRail). It exercises the
 * entire production path: hub.recordWrite → informer → EntityStore →
 * useEntityData → useEntities → useFleetModel → buildFleet → Supervision →
 * FleetRail/DetailRail.
 *
 * Harness mirrors use-fleet-model.mount.test.tsx (InformerProvider +
 * EntityStoreProvider + RemoteReportingLocalFactory so useEntityWatchEnabled
 * gates true; the unscoped provider stub returns [] from getClaims so the
 * ONLY Claim source is the informer — proving the informer path, not the
 * polling fallback).
 */

import { describe, expect, test } from "bun:test";
import type React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { InformerFactory } from "../../../core/informer.js";
import type { WatchEntity } from "../../../core/watch-events.js";
import { WatchHub } from "../../../core/watch-hub.js";
import { EntityStoreFactory } from "../../data/entity-store.js";
import { EntityStoreProvider } from "../../hooks/entity-store-context.js";
import { InformerProvider } from "../../hooks/informer-context.js";
import type { AgentMonitorState } from "../../hooks/use-agent-monitor.js";
import type { TuiDataProvider } from "../../provider.js";
import { Supervision } from "./supervision.js";
import { useFleetModel } from "./use-fleet-model.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NS = "default";
const NOW = Date.now();

/**
 * Test-only subclass: wires the local hub (so hub.recordWrite drives
 * events) but reports mode "remote" so useEntityWatchEnabled gates true.
 */
class RemoteReportingLocalFactory extends InformerFactory {
  override get mode(): "remote" | "local" {
    return "remote";
  }
}

/** A valid active Claim WatchEntity (== ClaimEntity for kind "Claim"). */
function claimEntity(agentId: string, role: string): WatchEntity {
  return {
    kind: "Claim",
    id: `claim-${agentId}`,
    namespace: NS,
    conditions: [],
    observedGeneration: 1,
    resourceVersion: "1",
    metadata: { generation: 1, creationTimestamp: new Date(NOW - 60_000).toISOString() },
    spec: {
      agent: { agentId, agentName: agentId, role, platform: "claude" },
      targetRef: `target-${agentId}`,
      intentSummary: "do thing",
      context: {},
    },
    status: {
      phase: "active",
      persistedPhase: "active",
      heartbeatAt: new Date(NOW).toISOString(),
      lastHeartbeatAt: new Date(NOW).toISOString(),
      leaseExpiresAt: new Date(NOW + 600_000).toISOString(),
      observedGeneration: 1,
      attemptCount: 0,
    },
  } as unknown as WatchEntity;
}

const monitorStub: AgentMonitorState = {
  agentOutputs: new Map(),
  agentOutputTimestamps: new Map(),
  pendingPermissions: [],
  ipcMessages: [],
  spinnerFrame: 0,
};

/**
 * Composition wrapper: calls the production hook then renders the full
 * Supervision component with its result (mirrors running-view's wiring).
 */
function Probe({ provider }: { provider: TuiDataProvider }) {
  const fleet = useFleetModel({
    provider,
    monitor: monitorStub,
    agentFailures: undefined,
    tmux: undefined,
    filterText: undefined,
    active: true,
  });
  return <Supervision agents={fleet} tail={[]} />;
}

async function mountProbe(
  provider: TuiDataProvider,
  informerFactory: RemoteReportingLocalFactory,
  storeFactory: EntityStoreFactory,
): Promise<TestRenderer.ReactTestRenderer> {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = TestRenderer.create(
      (
        <InformerProvider value={informerFactory} eager>
          <EntityStoreProvider value={storeFactory}>
            <Probe provider={provider} />
          </EntityStoreProvider>
        </InformerProvider>
      ) as React.ReactElement,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer as TestRenderer.ReactTestRenderer;
}

describe("Supervision — full-component informer render (#193)", () => {
  test("populated fleet renders via informer path", async () => {
    const hub = new WatchHub();
    const informerFactory = new RemoteReportingLocalFactory({
      mode: "local",
      hub,
      namespace: NS,
      listFn: () => [],
    });
    const storeFactory = new EntityStoreFactory(informerFactory);
    // Unscoped provider — getClaims returns []; the ONLY Claim source is
    // the informer store. Pre-fix (getClaims-only) → empty fleet → the
    // populated assertions below would all fail.
    const provider = {
      hasSessionScope: () => false,
      getClaims: async () => [],
    } as unknown as TuiDataProvider;

    const renderer = await mountProbe(provider, informerFactory, storeFactory);

    await act(async () => {
      hub.recordWrite({
        kind: "Claim",
        namespace: NS,
        op: "ADDED",
        entity: claimEntity("coder-a", "coder"),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const out = JSON.stringify(renderer.toJSON());

    // FleetRail header reflects ≥1 agent (NOT the "Fleet (0)" empty header).
    expect(out).toContain("Fleet (1");
    expect(out).not.toContain("Fleet (0)");
    // The agent renders as a lane.
    expect(out).toContain("coder-a");
    // Empty-state must be absent.
    expect(out).not.toContain("No agents registered");
    // DetailRail auto-selected agents[0]; the placeholder must be absent.
    expect(out).not.toContain("Select an agent (j/k) to view context");
    // DetailRail rendered the selected agent's identity (role/platform line
    // is unique to the populated detail view; the placeholder has no such
    // text). Proves the informer Claim flowed all the way to DetailRail.
    expect(out).toContain("(coder/claude)");
    // The active claim's intentSummary surfaces as the Task body.
    expect(out).toContain("do thing");

    renderer.unmount();
    await informerFactory.stopAll();
    storeFactory.dispose();
  });

  test("scope short-circuit: scoped provider yields empty even with informer Claim", async () => {
    const hub = new WatchHub();
    const informerFactory = new RemoteReportingLocalFactory({
      mode: "local",
      hub,
      namespace: NS,
      listFn: () => [],
    });
    const storeFactory = new EntityStoreFactory(informerFactory);
    // Scoped provider — useProviderScoped(provider) === true. Even though
    // an informer Claim exists, the fleet must be empty (no cross-session
    // leak), mirroring AgentListView's deliberate scoped-empty behavior.
    const provider = {
      hasSessionScope: () => true,
      getClaims: async () => [],
    } as unknown as TuiDataProvider;

    const renderer = await mountProbe(provider, informerFactory, storeFactory);

    await act(async () => {
      hub.recordWrite({
        kind: "Claim",
        namespace: NS,
        op: "ADDED",
        entity: claimEntity("coder-b", "coder"),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const out = JSON.stringify(renderer.toJSON());

    // Scoped guard yields empty → empty-state + Fleet (0) + placeholder.
    expect(out).toContain("Fleet (0)");
    expect(out).toContain("No agents registered");
    expect(out).toContain("Select an agent (j/k) to view context");
    expect(out).not.toContain("coder-b");

    renderer.unmount();
    await informerFactory.stopAll();
    storeFactory.dispose();
  });

  test("two active claims render both lanes via informer path", async () => {
    const hub = new WatchHub();
    const informerFactory = new RemoteReportingLocalFactory({
      mode: "local",
      hub,
      namespace: NS,
      listFn: () => [],
    });
    const storeFactory = new EntityStoreFactory(informerFactory);
    const provider = {
      hasSessionScope: () => false,
      getClaims: async () => [],
    } as unknown as TuiDataProvider;

    const renderer = await mountProbe(provider, informerFactory, storeFactory);

    await act(async () => {
      hub.recordWrite({
        kind: "Claim",
        namespace: NS,
        op: "ADDED",
        entity: claimEntity("coder-a", "coder"),
      });
      hub.recordWrite({
        kind: "Claim",
        namespace: NS,
        op: "ADDED",
        entity: claimEntity("reviewer-a", "reviewer"),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const out = JSON.stringify(renderer.toJSON());

    // Two agents counted in the FleetRail header.
    expect(out).toContain("Fleet (2");
    expect(out).not.toContain("Fleet (0)");
    // Both agents render as lanes.
    expect(out).toContain("coder-a");
    expect(out).toContain("reviewer-a");
    // Empty-state / placeholder absent (fleet is populated, agents[0] selected).
    expect(out).not.toContain("No agents registered");
    expect(out).not.toContain("Select an agent (j/k) to view context");

    renderer.unmount();
    await informerFactory.stopAll();
    storeFactory.dispose();
  });
});
