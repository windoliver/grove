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
}

/** A shuffle response for CYCLON peer sampling. */
export interface ShuffleResponse {
  /** Subset of the receiver's partial view to send back. */
  readonly offered: readonly PeerInfo[];
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
}

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
}
