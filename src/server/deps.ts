/**
 * Server dependency interfaces.
 *
 * All route handlers receive stores via Hono context variables,
 * injected by createApp(). This enables testing with real or mock stores.
 */

import type { ContentStore } from "../core/cas.js";
import type { FrontierCalculator } from "../core/frontier.js";
import type { GossipService } from "../core/gossip/types.js";
import type { OutcomeStore } from "../core/outcome.js";
import type { ClaimStore, ContributionStore } from "../core/store.js";
import type { AgentTopology } from "../core/topology.js";

/** Dependencies injected into the Hono application. */
export interface ServerDeps {
  readonly contributionStore: ContributionStore;
  readonly claimStore: ClaimStore;
  readonly cas: ContentStore;
  readonly frontier: FrontierCalculator;
  /** Optional gossip service. Routes return 501 when not configured. */
  readonly gossip?: GossipService | undefined;
  /** Optional outcome store. Routes return 501 when not configured. */
  readonly outcomeStore?: OutcomeStore | undefined;
  /** Optional agent topology. Routes return 404 when not configured. */
  readonly topology?: AgentTopology | undefined;
}

/** Hono environment type carrying injected dependencies. */
export interface ServerEnv {
  Variables: {
    deps: ServerDeps;
  };
}
