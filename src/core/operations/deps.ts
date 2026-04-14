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
import type { EventBus } from "../event-bus.js";
import type { FrontierCalculator } from "../frontier.js";
import type { HandoffStore } from "../handoff.js";
import type { HookRunner } from "../hooks.js";
import type { OutcomeStore } from "../outcome.js";
import type { ClaimStore, ContributionStore } from "../store.js";
import type { TopologyRouter } from "../topology-router.js";
import type { WorkspaceManager } from "../workspace.js";

/**
 * Persistent idempotency store for cross-process deduplication.
 *
 * The in-memory Map in contribute.ts handles single-flight within a single
 * process (pending Promise coalescence). This store handles the case where
 * separate CLI invocations hit the same key — without it, each process
 * starts with an empty Map and the key is silently ignored.
 */
export interface IdempotencyStore {
  /** Look up an unexpired entry. Returns fingerprint, result, and status. */
  lookup(
    cacheKey: string,
    ttlMs: number,
  ):
    | {
        readonly fingerprint: string;
        readonly resultJson: string;
        readonly status: string;
      }
    | undefined;
  /**
   * Durably reserve a key before starting the write. Returns true if this
   * process won the reservation, false if another process already holds it.
   * Uses INSERT OR IGNORE so concurrent callers cannot both succeed.
   */
  reserve(cacheKey: string, fingerprint: string): boolean;
  /** Update an already-reserved entry with the final result. */
  store(cacheKey: string, fingerprint: string, resultJson: string): void;
  /** Remove a pending reservation on pre-commit failure. */
  rollback(cacheKey: string): void;
  /** Remove all entries (testing only). */
  clear(): void;
}

/**
 * Dependencies required by operations.
 *
 * All operations receive a subset of these via the OperationDeps interface.
 * Every field is optional so that callers only supply what the target
 * operation actually needs. Operations that require a particular dep
 * check for its presence and return a validation error when it is missing.
 */
export interface OperationDeps {
  readonly contributionStore?: ContributionStore | undefined;
  readonly claimStore?: ClaimStore | undefined;
  readonly cas?: ContentStore | undefined;
  readonly frontier?: FrontierCalculator | undefined;
  readonly contract?: GroveContract | undefined;
  readonly workspace?: WorkspaceManager | undefined;
  readonly outcomeStore?: OutcomeStore | undefined;
  readonly bountyStore?: BountyStore | undefined;
  readonly creditsService?: CreditsService | undefined;
  /** Called after a contribution is written to invalidate caches (e.g., frontier). */
  readonly onContributionWrite?: (() => void) | undefined;
  /** Called after a contribution is written, receiving the CID. Used for session tagging. */
  readonly onContributionWritten?: ((cid: string) => void) | undefined;
  /** Optional event bus for agent notifications. */
  readonly eventBus?: EventBus | undefined;
  /** Optional topology router for routing contribution events to downstream agents. */
  readonly topologyRouter?: TopologyRouter | undefined;
  /** Optional handoff store for creating durable routing coordination records. */
  readonly handoffStore?: HandoffStore | undefined;
  /** Optional hook runner for executing after_contribute hooks. */
  readonly hookRunner?: HookRunner | undefined;
  /** Working directory for hook execution. */
  readonly hookCwd?: string | undefined;
  /** Persistent idempotency store for cross-process deduplication. */
  readonly idempotencyStore?: IdempotencyStore | undefined;
}
