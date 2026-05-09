import type { HandoffStore } from "../core/handoff.js";
import type { NexusClient } from "../nexus/client.js";
import { NexusHandoffStore } from "../nexus/nexus-handoff-store.js";

export interface HandoffStoreWiring {
  readonly handoffStore: HandoffStore;
  readonly handoffStoreForSession: (sessionId: string) => HandoffStore;
}

export function createNexusHandoffStores(client: NexusClient, zoneId: string): HandoffStoreWiring {
  return {
    handoffStore: new NexusHandoffStore(client, undefined, zoneId),
    handoffStoreForSession: (sessionId: string) => new NexusHandoffStore(client, sessionId, zoneId),
  };
}
