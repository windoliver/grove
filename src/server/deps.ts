/**
 * Server dependency interfaces.
 *
 * All route handlers receive stores via Hono context variables,
 * injected by createApp(). This enables testing with real or mock stores.
 */

import type { BountyStore } from "../core/bounty-store.js";
import type { ContentStore } from "../core/cas.js";
import type { GroveContract } from "../core/contract.js";
import type { CreditsService } from "../core/credits.js";
import type { FrontierCalculator } from "../core/frontier.js";
import type { FrontierRewardService } from "../core/frontier-reward-service.js";
import type { GossipService } from "../core/gossip/types.js";
import type { HandoffStore } from "../core/handoff.js";
import type { IdempotencyStore } from "../core/operations/deps.js";
import type { InboxReadSource, MessageDelivery } from "../core/operations/inbox-delegation.js";
import type { OutcomeStore } from "../core/outcome.js";
import type { AgentTaskStore, ClaimStore, ContributionStore } from "../core/store.js";
import type { AgentTopology } from "../core/topology.js";
import type { WatchHub } from "../core/watch-hub.js";
import type { GoalSessionStore } from "../local/sqlite-goal-session-store.js";
import type { NexusWatchSubscriber } from "../nexus/nexus-watch-subscriber.js";

/** Dependencies injected into the Hono application. */
export interface ServerDeps {
  readonly contributionStore: ContributionStore;
  /**
   * Factory for session-scoped contribution stores. Optional: when provided,
   * HTTP routes that accept `?sessionId=` construct a scoped store per request
   * so the Nexus FTS index is read from `/zones/{zoneId}/sessions/{sessionId}/`
   * rather than the zone root. When omitted, routes fall back to the global
   * `contributionStore` (zone-wide).
   *
   * Required in Nexus mode because MCP agents write to session-scoped VFS
   * paths; the HTTP list API would otherwise return [] for any session query.
   */
  readonly contributionStoreForSession?: ((sessionId: string) => ContributionStore) | undefined;
  readonly claimStore: ClaimStore;
  /** Optional agent task lifecycle store. Routes return 501 when not configured. */
  readonly agentTaskStore?: AgentTaskStore | undefined;
  readonly cas: ContentStore;
  readonly frontier: FrontierCalculator;
  /**
   * Factory for session-scoped frontier calculators. Optional: when provided,
   * routes that accept `?sessionId=` compute rankings over the same scoped
   * contribution store used for session reads.
   */
  readonly frontierForSession?: ((sessionId: string) => FrontierCalculator) | undefined;
  /** Optional gossip service. Routes return 501 when not configured. */
  readonly gossip?: GossipService | undefined;
  /** Optional token required for controller-owned status writes. */
  readonly controllerToken?: string | undefined;
  /** HMAC secret for gossip route verification (required when gossip is configured). */
  readonly gossipHmacSecret?: string | undefined;
  /** Optional outcome store. Routes return 501 when not configured. */
  readonly outcomeStore?: OutcomeStore | undefined;
  /** Optional bounty store. Routes return 501 when not configured. */
  readonly bountyStore?: BountyStore | undefined;
  /** Optional credits service for bounty escrow and reward transfers. */
  readonly creditsService?: CreditsService | undefined;
  /** Optional reward evaluator for frontier-advance credits. */
  readonly frontierRewardService?: FrontierRewardService | undefined;
  /** Optional agent topology. Routes return 404 when not configured. */
  readonly topology?: AgentTopology | undefined;
  /** Optional goal/session store. Routes return 501 when not configured. */
  readonly goalSessionStore?: GoalSessionStore | undefined;
  /** Optional contract snapshot. Routes return 501 when not configured. */
  readonly contract?: GroveContract | undefined;
  /** Optional handoff store. Routes return 501 when not configured. */
  readonly handoffStore?: HandoffStore | undefined;
  /** Optional source for recipient-scoped inbox reads. */
  readonly inboxReadSource?: InboxReadSource | undefined;
  /** Optional delivery adapter for ephemeral message sends. */
  readonly messageDelivery?: MessageDelivery | undefined;
  /** Optional factory for request/session-scoped message delivery. */
  readonly messageDeliveryForSession?:
    | ((sessionId: string | undefined) => MessageDelivery | undefined)
    | undefined;
  /**
   * Factory for session-scoped handoff stores. Optional: when provided,
   * HTTP routes that need session isolation (e.g. GET/list under a
   * ?sessionId= query) can construct a scoped store per request. When
   * omitted, routes fall back to the global `handoffStore` (unscoped).
   *
   * This is primarily needed for the grove-server HTTP surface in local
   * mode, where the process-global store spans all sessions and remote
   * TUI reads would leak cross-session handoffs otherwise.
   */
  readonly handoffStoreForSession?: (sessionId: string) => HandoffStore | undefined;
  /** Optional idempotency store for cross-process deduplication. */
  readonly idempotencyStore?: IdempotencyStore | undefined;
  /** Watch hub for list→watch handshake (#292). */
  readonly watchHub: WatchHub;
  /**
   * Optional cross-process watch subscriber (#292). When present, the
   * operation-adapter calls `markSeen` on it after each in-process write
   * so that the matching cross-process envelope (published by the same
   * write through Nexus → NexusWatchPublisher) is suppressed at the
   * subscriber instead of being replayed back into the WatchHub.
   *
   * Optional so test harnesses that build ServerDeps inline can omit it.
   */
  readonly watchSubscriber?: NexusWatchSubscriber | undefined;
}

/** Hono environment type carrying injected dependencies. */
export interface ServerEnv {
  Variables: {
    deps: ServerDeps;
    namespace: string;
  };
}
