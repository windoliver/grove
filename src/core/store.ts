/**
 * Store protocols for the contribution graph.
 *
 * These define the abstract interface that storage backends must implement.
 * The local SQLite adapter and the Nexus adapter both satisfy these protocols.
 */

import type {
  Claim,
  Contribution,
  ContributionKind,
  ContributionMode,
  Relation,
  RelationType,
} from "./models.js";

/** Filters for querying contributions. */
export interface ContributionQuery {
  readonly kind?: ContributionKind | undefined;
  readonly mode?: ContributionMode | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly agentId?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/** Store for immutable contributions and their typed relations. */
export interface ContributionStore {
  /** Store a contribution (idempotent — same CID is a no-op). */
  put(contribution: Contribution): Promise<void>;

  /** Retrieve a contribution by CID. */
  get(cid: string): Promise<Contribution | undefined>;

  /** List contributions matching filters. */
  list(query?: ContributionQuery): Promise<readonly Contribution[]>;

  /** Get contributions that derive from or adopt this CID. */
  children(cid: string): Promise<readonly Contribution[]>;

  /** Get contributions that this CID derives from or adopts. */
  ancestors(cid: string): Promise<readonly Contribution[]>;

  /** Get relations originating from this CID. */
  relationsOf(cid: string, relationType?: RelationType): Promise<readonly Relation[]>;

  /** Get contributions related to this CID (incoming relations). */
  relatedTo(cid: string, relationType?: RelationType): Promise<readonly Contribution[]>;

  /** Full-text search on summary and description. */
  search(query: string, filters?: ContributionQuery): Promise<readonly Contribution[]>;

  /** Count contributions matching filters. */
  count(query?: ContributionQuery): Promise<number>;
}

/** Store for mutable claims (coordination objects). */
export interface ClaimStore {
  /** Create a new claim. */
  createClaim(claim: Claim): Promise<void>;

  /** Get a claim by ID. */
  getClaim(claimId: string): Promise<Claim | undefined>;

  /** Update heartbeat timestamp and renew lease. */
  heartbeat(claimId: string): Promise<void>;

  /** Release a claim (agent gives up). */
  release(claimId: string): Promise<void>;

  /** Mark a claim as completed. */
  complete(claimId: string): Promise<void>;

  /** Expire all claims past their lease. Returns expired claims. */
  expireStale(): Promise<readonly Claim[]>;

  /** List active claims, optionally filtered by target. */
  activeClaims(targetRef?: string): Promise<readonly Claim[]>;
}
