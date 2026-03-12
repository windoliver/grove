/**
 * Operation dependency interface.
 *
 * All operations receive their dependencies through this interface,
 * making them independent of any specific surface (CLI, MCP, HTTP).
 */

import type { BountyStore } from "../bounty-store.js";
import type { ContentStore } from "../cas.js";
import type { GroveContract } from "../contract.js";
import type { CreditsService } from "../credits.js";
import type { FrontierCalculator } from "../frontier.js";
import type { OutcomeStore } from "../outcome.js";
import type { ClaimStore, ContributionStore } from "../store.js";
import type { WorkspaceManager } from "../workspace.js";

/**
 * Dependencies required by operations.
 *
 * All operations receive a subset of these via the OperationDeps interface.
 * Required deps (contributionStore, claimStore, cas, frontier) are always
 * available. Optional deps are only present when the feature is configured.
 */
export interface OperationDeps {
  readonly contributionStore: ContributionStore;
  readonly claimStore: ClaimStore;
  readonly cas: ContentStore;
  readonly frontier: FrontierCalculator;
  readonly contract?: GroveContract | undefined;
  readonly workspace?: WorkspaceManager | undefined;
  readonly outcomeStore?: OutcomeStore | undefined;
  readonly bountyStore?: BountyStore | undefined;
  readonly creditsService?: CreditsService | undefined;
  /** Called after a contribution is written to invalidate caches (e.g., frontier). */
  readonly onContributionWrite?: (() => void) | undefined;
}
