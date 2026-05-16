/**
 * Gossip protocol types.
 *
 * Defines the wire format for gossip messages, peer sampling, and
 * failure detection. These types are protocol-level — they belong
 * in core/ so that both gossip implementations and future Nexus
 * adapters can share them.
 */

import type { JsonValue } from "../models.js";

// ---------------------------------------------------------------------------
// Peer types
// ---------------------------------------------------------------------------

/** Information about a peer grove-server in the gossip network. */
export interface PeerInfo {
  /** Unique identifier for this peer server. */
  readonly peerId: string;
  /** HTTP base URL for gossip endpoints (e.g., "http://localhost:4515"). */
  readonly address: string;
  /** Age in shuffle rounds (incremented each round, reset on shuffle). */
  readonly age: number;
  /** Timestamp of last successful communication. */
  readonly lastSeen: string;
}

/** Peer liveness status. */
export const PeerStatus = {
  Alive: "alive",
  Suspected: "suspected",
  Failed: "failed",
} as const;
export type PeerStatus = (typeof PeerStatus)[keyof typeof PeerStatus];

/** Peer liveness state tracked by gossip. */
export interface PeerLiveness {
  readonly peer: PeerInfo;
  readonly status: PeerStatus;
  readonly lastSeen: string;
  /** When suspicion started (undefined if alive). */
  readonly suspectedAt?: string | undefined;
}

// ---------------------------------------------------------------------------
// Gossip message types
// ---------------------------------------------------------------------------

/** A frontier entry in a gossip digest — compact top-K representation. */
export interface FrontierDigestEntry {
  readonly metric: string;
  readonly value: number;
  readonly cid: string;
  readonly tags?: readonly string[] | undefined;
  /** Score direction for this metric. When absent, "maximize" is assumed for backward compatibility. */
  readonly direction?: "minimize" | "maximize" | undefined;
}

/** Load information for a peer server. */
export interface PeerLoad {
  readonly queueDepth: number;
}

/**
 * Agent capacity information for a peer server (boardroom).
 *
 * Included in gossip messages so that peers can delegate work
 * to nodes with available agent slots.
 */
export interface AgentCapacity {
  /** Total agent slots available on this peer. */
  readonly totalSlots: number;
  /** Currently occupied agent slots. */
  readonly usedSlots: number;
  /** Number of free slots (totalSlots - usedSlots). */
  readonly freeSlots: number;
}

/** Capabilities of a peer server. */
export interface PeerCapabilities {
  readonly platform?: string | undefined;
  readonly [key: string]: JsonValue | undefined;
}

/** A gossip message exchanged between grove-server instances. */
export interface GossipMessage {
  /** Unique identifier of the sending server. */
  readonly peerId: string;
  /** Sender's HTTP base URL for gossip endpoints (enables peer discovery via exchange). */
  readonly address?: string | undefined;
  /** Compact frontier digest (top-K entries per dimension). */
  readonly frontier: readonly FrontierDigestEntry[];
  /** Load information for work distribution. */
  readonly load: PeerLoad;
  /** Server capabilities for filtering. */
  readonly capabilities: PeerCapabilities;
  /** Timestamp of this message. */
  readonly timestamp: string;
  /** Agent capacity for gossip-aware spawning (boardroom). */
  readonly agentCapacity?: AgentCapacity | undefined;
  /** HMAC-SHA256 signature over the message payload (set when hmacSecret is configured). */
  readonly hmacSignature?: string | undefined;
}

// ---------------------------------------------------------------------------
// CYCLON shuffle types
// ---------------------------------------------------------------------------

/** A shuffle request for CYCLON peer sampling. */
export interface ShuffleRequest {
  /** The sender's peer info (with age reset to 0). */
  readonly sender: PeerInfo;
  /** Subset of the sender's partial view to exchange. */
  readonly offered: readonly PeerInfo[];
  /** HMAC-SHA256 signature over the request payload (set when hmacSecret is configured). */
  readonly hmacSignature?: string | undefined;
}

/** A shuffle response for CYCLON peer sampling. */
export interface ShuffleResponse {
  /** Subset of the receiver's partial view to send back. */
  readonly offered: readonly PeerInfo[];
  /** HMAC-SHA256 signature over the response payload (set when hmacSecret is configured). */
  readonly hmacSignature?: string | undefined;
}

// ---------------------------------------------------------------------------
// Gossip events
// ---------------------------------------------------------------------------

/** Events emitted by the gossip service. */
export const GossipEventType = {
  PeerJoined: "peer_joined",
  PeerSuspected: "peer_suspected",
  PeerFailed: "peer_failed",
  PeerRecovered: "peer_recovered",
  FrontierUpdated: "frontier_updated",
  RoundFailed: "round_failed",
} as const;
export type GossipEventType = (typeof GossipEventType)[keyof typeof GossipEventType];

/** A gossip event for external consumers. */
export interface GossipEvent {
  readonly type: GossipEventType;
  readonly peerId: string;
  readonly timestamp: string;
}

/** Listener for gossip events. */
export type GossipEventListener = (event: GossipEvent) => void;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration for the gossip service. */
export interface GossipConfig {
  /** This server's unique peer ID. */
  readonly peerId: string;
  /** This server's address (for self-identification in shuffles). */
  readonly address: string;
  /** Seed peers for initial contact. */
  readonly seedPeers: readonly PeerInfo[];
  /** Gossip interval in milliseconds (default: 30_000). */
  readonly intervalMs?: number | undefined;
  /** Fan-out: number of peers to gossip with per round (default: 3). */
  readonly fanOut?: number | undefined;
  /** Jitter factor for interval randomization (default: 0.2 = ±20%). */
  readonly jitter?: number | undefined;
  /** Maximum partial view size for peer sampling (default: 10). */
  readonly maxViewSize?: number | undefined;
  /** Shuffle length: entries to exchange per shuffle (default: 5). */
  readonly shuffleLength?: number | undefined;
  /** Top-K entries per frontier dimension in digest (default: 5). */
  readonly digestLimit?: number | undefined;
  /** Milliseconds before a non-responding peer is suspected (default: 90_000). */
  readonly suspicionTimeoutMs?: number | undefined;
  /** Milliseconds before a suspected peer is declared failed (default: 150_000). */
  readonly failureTimeoutMs?: number | undefined;
  /** Shared secret for HMAC-SHA256 message signing. When set, outgoing messages are signed and incoming unsigned messages are rejected. */
  readonly hmacSecret?: string | undefined;
  /**
   * Background anti-entropy: when set, the gossip service periodically pulls
   * frontier entries from peers that aren't yet stored locally. Disabled by
   * default — set `enabled: true` to opt in.
   */
  readonly antiEntropy?:
    | {
        readonly enabled: boolean;
        /** Interval between sweeps in ms. Defaults to 5× gossip interval. */
        readonly intervalMs?: number | undefined;
        /** Maximum CIDs to fetch per sweep. Defaults to 16. */
        readonly batchSize?: number | undefined;
        /** Per-metric value threshold; entries below the threshold are skipped. */
        readonly metricThresholds?: Readonly<Record<string, number>> | undefined;
      }
    | undefined;
}

// ---------------------------------------------------------------------------
// Service protocols
// ---------------------------------------------------------------------------

/** Transport protocol for gossip HTTP communication. */
export interface GossipTransport {
  /** Send a gossip exchange to a peer. Returns the peer's gossip message. */
  exchange(peer: PeerInfo, message: GossipMessage): Promise<GossipMessage>;
  /** Send a CYCLON shuffle request to a peer. Returns the shuffle response. */
  shuffle(peer: PeerInfo, request: ShuffleRequest): Promise<ShuffleResponse>;
  /**
   * Fetch a contribution manifest from a peer by CID. Returns undefined when the
   * peer responds 404. Throws PeerUnreachableError / GossipTimeoutError for
   * network failures. The optional `maxBytes` bound caps the response so a
   * malicious peer cannot force the server to buffer a very large JSON body
   * (e.g. multi-MB strings inside context/description) before the manifest
   * schema check runs.
   */
  fetchContribution(
    peer: PeerInfo,
    cid: string,
    maxBytes?: number,
  ): Promise<unknown | undefined>;

  /**
   * Fetch raw artifact bytes from a peer scoped to a (contribution CID,
   * artifact name) pair. Returns undefined when the peer responds 404.
   * Throws PeerUnreachableError / GossipTimeoutError for network failures.
   * Callers MUST re-hash the returned bytes and compare to the manifest's
   * declared hash before storing them locally.
   *
   * Federation reads MUST stay scoped to a contribution rather than going
   * by raw CAS hash: in deployments with a shared zone CAS, a hash-keyed
   * fetch would leak any blob present in the CAS (including blobs only
   * referenced by session-scoped contributions). The contribution-scoped
   * path delegates the authorization boundary to the local server's root
   * contribution store, which only resolves `:cid` against the zone root.
   */
  fetchArtifact(
    peer: PeerInfo,
    cid: string,
    artifactName: string,
    /**
     * Optional upper bound on the response size in bytes. When supplied,
     * the transport rejects responses whose declared Content-Length exceeds
     * the bound and aborts streaming if the running total goes past it.
     * Callers (federation fetcher) pass the remaining per-contribution
     * byte budget so a single oversized response cannot blow past the cap.
     */
    maxBytes?: number,
  ): Promise<Uint8Array | undefined>;
}

/**
 * Result of a federation fetch attempt for a remote contribution.
 *
 * - `ok` — manifest + artifacts were verified and persisted locally.
 * - `already-local` — the cid was already present in the local store.
 * - `no-source` — no peer has advertised this cid via gossip.
 * - `failed` — every advertising peer errored; `reason` is an aggregated
 *   diagnostic string (peer id + error) for logging.
 */
export type FetchContributionResult =
  | { readonly kind: "ok"; readonly cid: string }
  | { readonly kind: "already-local"; readonly cid: string }
  | { readonly kind: "no-source"; readonly cid: string }
  | { readonly kind: "failed"; readonly cid: string; readonly reason: string };

/** Protocol for the gossip service. */
export interface GossipService {
  /** Start the gossip background loop. */
  start(): void;
  /** Stop the gossip background loop. Returns when fully stopped. */
  stop(): Promise<void>;
  /** Handle an incoming gossip exchange from a peer. Returns our message. */
  handleExchange(message: GossipMessage): Promise<GossipMessage>;
  /** Handle an incoming shuffle request from a peer. Returns shuffle response. */
  handleShuffle(request: ShuffleRequest): ShuffleResponse;
  /** Get the current partial view of peers. */
  peers(): readonly PeerInfo[];
  /** Get liveness status of all known peers. */
  liveness(): readonly PeerLiveness[];
  /** Get the current gossip message (for outgoing exchange). */
  currentMessage(): Promise<GossipMessage>;
  /** Get the merged frontier (local + remote entries). */
  mergedFrontier(): readonly FrontierDigestEntry[];
  /** Register a listener for gossip events. */
  on(listener: GossipEventListener): void;
  /** Remove a listener. */
  off(listener: GossipEventListener): void;
  /**
   * Peers that have advertised the given CID via gossip frontier (most-recent
   * advertisement wins per peer). Returns an empty array if no peer has
   * advertised this CID. The address may be undefined for legacy peers that
   * gossiped without an address — those entries cannot be fetched from.
   *
   * Order is unspecified — callers must not rely on it.
   */
  peersAdvertising(cid: string): readonly PeerInfo[];
  /**
   * Pull a contribution (and its artifacts) from any peer that has advertised
   * this CID via gossip. Verifies BLAKE3 hashes on every artifact before
   * persisting. Returns `{ kind: "ok", cid }` when the local store now contains
   * the contribution, `{ kind: "already-local" }` when it was already present,
   * `{ kind: "no-source" }` when no peer has advertised it, and
   * `{ kind: "failed", reason }` when all advertising peers errored.
   */
  fetchRemoteContribution(cid: string): Promise<FetchContributionResult>;
}
