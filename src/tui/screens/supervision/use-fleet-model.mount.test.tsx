/**
 * Mount integration: useFleetModel under InformerProvider + EntityStoreProvider.
 *
 * Reproduces #193 — in nexus mode the live Claim source is the
 * informer-backed EntityStore (surfaced via useEntityData → useEntities),
 * NOT the polled `provider.getClaims` fallback. Before the fix
 * useFleetModel only read the polling fallback, so a freshly written
 * informer Claim never reached the FleetRail ("Fleet (0)").
 *
 * Harness mirrors use-entity-data.mount.test.tsx (InformerProvider +
 * EntityStoreProvider + RemoteReportingLocalFactory so
 * useEntityWatchEnabled gates true; hub.recordWrite pushes a Claim
 * WatchEntity into the store).
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
import { type FleetAgent, useFleetModel } from "./use-fleet-model.js";

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

function Probe({
  onResult,
  provider,
}: {
  onResult: (r: readonly FleetAgent[]) => void;
  provider: TuiDataProvider;
}) {
  const fleet = useFleetModel({
    provider,
    monitor: monitorStub,
    agentFailures: undefined,
    tmux: undefined,
    filterText: undefined,
    active: true,
  });
  onResult(fleet);
  return null;
}

describe("useFleetModel — mount integration (#193)", () => {
  test("informer path: a recorded active Claim surfaces in the fleet", async () => {
    const hub = new WatchHub();
    const informerFactory = new RemoteReportingLocalFactory({
      mode: "local",
      hub,
      namespace: NS,
      listFn: () => [],
    });
    const storeFactory = new EntityStoreFactory(informerFactory);
    // Unscoped provider — getClaims returns []; the ONLY Claim source is
    // the informer store. With the pre-fix code (useEventDrivenData over
    // provider.getClaims) the fleet stays empty.
    const provider = {
      hasSessionScope: () => false,
      getClaims: async () => [],
    } as unknown as TuiDataProvider;

    let last: readonly FleetAgent[] = [];
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <InformerProvider value={informerFactory} eager>
            <EntityStoreProvider value={storeFactory}>
              <Probe
                provider={provider}
                onResult={(r) => {
                  last = r;
                }}
              />
            </EntityStoreProvider>
          </InformerProvider>
        ) as React.ReactElement,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      hub.recordWrite({
        kind: "Claim",
        namespace: NS,
        op: "ADDED",
        entity: claimEntity("coder-1", "coder"),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(last.length).toBeGreaterThanOrEqual(1);
    expect(last[0]?.agentId).toBe("coder-1");

    renderer?.unmount();
    await informerFactory.stopAll();
    storeFactory.dispose();
  });

  test("scoped short-circuit: returns empty even with an informer Claim", async () => {
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

    let last: readonly FleetAgent[] = [{ agentId: "sentinel" } as unknown as FleetAgent];
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <InformerProvider value={informerFactory} eager>
            <EntityStoreProvider value={storeFactory}>
              <Probe
                provider={provider}
                onResult={(r) => {
                  last = r;
                }}
              />
            </EntityStoreProvider>
          </InformerProvider>
        ) as React.ReactElement,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      hub.recordWrite({
        kind: "Claim",
        namespace: NS,
        op: "ADDED",
        entity: claimEntity("coder-2", "coder"),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(last).toEqual([]);
    expect(last.length).toBe(0);

    renderer?.unmount();
    await informerFactory.stopAll();
    storeFactory.dispose();
  });
});
