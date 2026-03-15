/**
 * Federated swarm preset — gossip-enabled multi-node agent swarm.
 *
 * A flat topology of general-purpose workers coordinated via
 * gossip protocol with delegate spawning.
 */

import type { PresetConfig } from "./index.js";

export const federatedSwarmPreset: PresetConfig = {
  name: "federated-swarm",
  description: "Federated multi-node agent swarm with gossip coordination",
  mode: "exploration",
  topology: {
    structure: "flat",
    roles: [
      {
        name: "worker",
        description: "General-purpose task worker",
        maxInstances: 8,
        command: "claude --role worker",
        platform: "claude-code",
      },
    ],
    spawning: { dynamic: true, maxDepth: 1, maxChildrenPerAgent: 4 },
  },
  concurrency: {
    maxActiveClaims: 8,
    maxClaimsPerAgent: 2,
  },
  execution: {
    defaultLeaseSeconds: 300,
    maxLeaseSeconds: 1800,
  },
  services: { server: true, mcp: false },
  backend: "nexus",
  features: {
    gossip: { delegateSpawning: true },
    costTracking: true,
    messaging: true,
  },
};
