/**
 * Server dependency interfaces.
 *
 * All route handlers receive stores via Hono context variables,
 * injected by createApp(). This enables testing with real or mock stores.
 */

import type { ContentStore } from "../core/cas.js";
import type { FrontierCalculator } from "../core/frontier.js";
import type { ClaimStore, ContributionStore } from "../core/store.js";

/** Dependencies injected into the Hono application. */
export interface ServerDeps {
  readonly contributionStore: ContributionStore;
  readonly claimStore: ClaimStore;
  readonly cas: ContentStore;
  readonly frontier: FrontierCalculator;
}

/** Hono environment type carrying injected dependencies. */
export interface ServerEnv {
  Variables: {
    deps: ServerDeps;
  };
}
