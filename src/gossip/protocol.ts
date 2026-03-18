/**
 * Gossip protocol implementation.
 *
 * Orchestrates CYCLON peer sampling, frontier digest exchange, and
 * failure detection into a cohesive gossip service. Runs a background
 * loop that periodically exchanges state with random peers.
 *
 * Architecture:
 * - CyclonPeerSampler: manages the partial view of peers
 * - GossipTransport: handles HTTP communication
 * - FrontierCalculator: computes local frontier for digest generation
 * - Liveness tracker: detects suspected/failed peers via gossip rounds
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  DEFAULT_FAILURE_TIMEOUT_MS,
  DEFAULT_FRONTIER_DIGEST_LIMIT,
  DEFAULT_GOSSIP_FAN_OUT,
  DEFAULT_GOSSIP_INTERVAL_MS,
  DEFAULT_GOSSIP_JITTER,
  DEFAULT_PARTIAL_VIEW_SIZE,
  DEFAULT_SHUFFLE_LENGTH,
  DEFAULT_SUSPICION_TIMEOUT_MS,
  MAX_GOSSIP_FRONTIER_ENTRIES,
  MAX_MERGED_FRONTIER_ENTRIES,
} from "../core/constants.js";
import type { FrontierCalculator, FrontierEntry } from "../core/frontier.js";
import {
  type FrontierDigestEntry,
  type GossipConfig,
  type GossipEvent,
  type GossipEventListener,
  GossipEventType,
  type GossipMessage,
  type GossipService,
  type GossipTransport,
  type PeerCapabilities,
  type PeerInfo,
  type PeerLiveness,
  type PeerLoad,
  PeerStatus,
  type ShuffleRequest,
  type ShuffleResponse,
} from "../core/gossip/types.js";
import { CyclonPeerSampler } from "./cyclon.js";

// ---------------------------------------------------------------------------
// Direction-aware helpers
// ---------------------------------------------------------------------------

/**
 * Compare two values, respecting the metric direction. Default: maximize.
 *
 * When the candidate omits direction, falls back to the existing entry's
 * direction (backward compatibility with legacy peers that don't send it).
 */
function isBetterValue(
  candidate: number,
  existing: number,
  candidateDirection: "minimize" | "maximize" | undefined,
  existingDirection: "minimize" | "maximize" | undefined,
): boolean {
  const direction = candidateDirection ?? existingDirection ?? "maximize";
  return direction === "minimize" ? candidate < existing : candidate > existing;
}

/**
 * Returns a normalized "goodness" value for eviction sorting.
 * Higher return value = "better" entry regardless of direction.
 * For maximize: higher value is better → return as-is.
 * For minimize: lower value is better → negate so lower values become higher.
 */
function sortValueForEviction(entry: FrontierDigestEntry): number {
  return entry.direction === "minimize" ? -entry.value : entry.value;
}

// ---------------------------------------------------------------------------
// Liveness state
// ---------------------------------------------------------------------------

/** Internal mutable liveness state per peer. */
interface LivenessState {
  status: PeerStatus;
  lastSeen: number;
  suspectedAt: number | undefined;
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 message signing
// ---------------------------------------------------------------------------

/** Compute HMAC-SHA256 over a payload (excluding the hmacSignature field). */
function signPayload(payload: Record<string, unknown>, secret: string): string {
  const { hmacSignature: _, ...data } = payload;
  const hmac = createHmac("sha256", secret);
  hmac.update(JSON.stringify(data));
  return hmac.digest("hex");
}

/** Verify HMAC-SHA256 signature on a payload using timing-safe comparison. */
function verifyPayload(
  payload: Record<string, unknown> & { hmacSignature?: string },
  secret: string,
): boolean {
  if (!payload.hmacSignature) return false;
  const expected = signPayload(payload, secret);
  if (payload.hmacSignature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(payload.hmacSignature), Buffer.from(expected));
}

// ---------------------------------------------------------------------------
// DefaultGossipService
// ---------------------------------------------------------------------------

/**
 * Concrete gossip service implementation.
 *
 * Combines CYCLON peer sampling with push-pull frontier exchange and
 * liveness tracking. Runs a background loop with jittered intervals.
 */
export class DefaultGossipService implements GossipService {
  private readonly config: {
    readonly peerId: string;
    readonly address: string;
    readonly intervalMs: number;
    readonly fanOut: number;
    readonly jitter: number;
    readonly digestLimit: number;
    readonly suspicionTimeoutMs: number;
    readonly failureTimeoutMs: number;
    readonly hmacSecret: string | undefined;
  };
  private readonly sampler: CyclonPeerSampler;
  private readonly transport: GossipTransport;
  private readonly frontier: FrontierCalculator;
  private readonly capabilities: PeerCapabilities;
  private readonly getLoad: () => PeerLoad;
  private readonly getActiveClaimCount: (() => Promise<number>) | undefined;
  private readonly maxAgentSlots: number;
  private readonly listeners: Set<GossipEventListener> = new Set();
  private readonly livenessMap = new Map<string, LivenessState>();
  private remoteFrontier: FrontierDigestEntry[] = [];
  private localDigest: FrontierDigestEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private consecutiveFailures = 0;
  private readonly now: () => number;

  constructor(opts: {
    config: GossipConfig;
    transport: GossipTransport;
    frontier: FrontierCalculator;
    capabilities?: PeerCapabilities;
    getLoad?: () => PeerLoad;
    now?: () => number;
    /** Pre-populate remote frontier (e.g., from persisted state). */
    initialFrontier?: readonly FrontierDigestEntry[];
    /** Callback to get the current number of active claims (for agent capacity). */
    getActiveClaimCount?: () => Promise<number>;
    /** Maximum agent slots available on this peer (default: 8). */
    maxAgentSlots?: number;
  }) {
    this.config = {
      peerId: opts.config.peerId,
      address: opts.config.address,
      intervalMs: opts.config.intervalMs ?? DEFAULT_GOSSIP_INTERVAL_MS,
      fanOut: opts.config.fanOut ?? DEFAULT_GOSSIP_FAN_OUT,
      jitter: opts.config.jitter ?? DEFAULT_GOSSIP_JITTER,
      digestLimit: opts.config.digestLimit ?? DEFAULT_FRONTIER_DIGEST_LIMIT,
      suspicionTimeoutMs: opts.config.suspicionTimeoutMs ?? DEFAULT_SUSPICION_TIMEOUT_MS,
      failureTimeoutMs: opts.config.failureTimeoutMs ?? DEFAULT_FAILURE_TIMEOUT_MS,
      hmacSecret: opts.config.hmacSecret,
    };

    const selfPeer: PeerInfo = {
      peerId: this.config.peerId,
      address: this.config.address,
      age: 0,
      lastSeen: new Date().toISOString(),
    };

    this.sampler = new CyclonPeerSampler(
      selfPeer,
      {
        maxViewSize: opts.config.maxViewSize ?? DEFAULT_PARTIAL_VIEW_SIZE,
        shuffleLength: opts.config.shuffleLength ?? DEFAULT_SHUFFLE_LENGTH,
      },
      opts.config.seedPeers,
    );

    this.transport = opts.transport;
    this.frontier = opts.frontier;
    this.capabilities = opts.capabilities ?? {};
    this.getLoad = opts.getLoad ?? (() => ({ queueDepth: 0 }));
    this.getActiveClaimCount = opts.getActiveClaimCount;
    this.maxAgentSlots = opts.maxAgentSlots ?? 8;
    this.now = opts.now ?? Date.now;

    // Initialize liveness for seed peers
    for (const peer of opts.config.seedPeers) {
      this.livenessMap.set(peer.peerId, {
        status: PeerStatus.Alive,
        lastSeen: this.now(),
        suspectedAt: undefined,
      });
    }

    // Restore persisted frontier if provided
    if (opts.initialFrontier && opts.initialFrontier.length > 0) {
      this.remoteFrontier = [...opts.initialFrontier];
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNextRound();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Gossip exchange
  // -------------------------------------------------------------------------

  async handleExchange(message: GossipMessage): Promise<GossipMessage> {
    // Verify HMAC if configured
    if (this.config.hmacSecret) {
      if (!verifyPayload(message as unknown as Record<string, unknown>, this.config.hmacSecret)) {
        console.warn(`Gossip: rejecting exchange from ${message.peerId} — invalid or missing HMAC`);
        return this.currentMessage();
      }
    }

    // Update liveness for sender
    this.markAlive(message.peerId);

    // Merge remote frontier entries
    this.mergeRemoteFrontier(message.frontier);

    // Add sender to our view only if they provided a routable address
    if (message.address) {
      const senderPeer: PeerInfo = {
        peerId: message.peerId,
        address: message.address,
        age: 0,
        lastSeen: message.timestamp,
      };
      this.sampler.addPeer(senderPeer);
    }

    // Return our current message
    return this.currentMessage();
  }

  handleShuffle(request: ShuffleRequest): ShuffleResponse {
    // Verify HMAC if configured
    if (this.config.hmacSecret) {
      if (!verifyPayload(request as unknown as Record<string, unknown>, this.config.hmacSecret)) {
        console.warn(
          `Gossip: rejecting shuffle from ${request.sender.peerId} — invalid or missing HMAC`,
        );
        return { offered: [] };
      }
    }

    this.markAlive(request.sender.peerId);
    return this.sampler.handleShuffleRequest(request);
  }

  // -------------------------------------------------------------------------
  // State queries
  // -------------------------------------------------------------------------

  peers(): readonly PeerInfo[] {
    return this.sampler.getView();
  }

  liveness(): readonly PeerLiveness[] {
    const result: PeerLiveness[] = [];
    for (const peer of this.sampler.getView()) {
      const state = this.livenessMap.get(peer.peerId);
      result.push({
        peer,
        status: state?.status ?? PeerStatus.Alive,
        lastSeen: state ? new Date(state.lastSeen).toISOString() : peer.lastSeen,
        suspectedAt: state?.suspectedAt ? new Date(state.suspectedAt).toISOString() : undefined,
      });
    }
    return result;
  }

  async currentMessage(): Promise<GossipMessage> {
    const digest = await this.computeDigest();

    // Compute agent capacity if claim count callback is available
    let agentCapacity: GossipMessage["agentCapacity"];
    if (this.getActiveClaimCount) {
      const usedSlots = await this.getActiveClaimCount();
      agentCapacity = {
        totalSlots: this.maxAgentSlots,
        usedSlots,
        freeSlots: Math.max(0, this.maxAgentSlots - usedSlots),
      };
    }

    const message: GossipMessage = {
      peerId: this.config.peerId,
      address: this.config.address,
      frontier: digest,
      load: this.getLoad(),
      capabilities: this.capabilities,
      timestamp: new Date(this.now()).toISOString(),
      agentCapacity,
    };

    if (this.config.hmacSecret) {
      return {
        ...message,
        hmacSignature: signPayload(
          message as unknown as Record<string, unknown>,
          this.config.hmacSecret,
        ),
      };
    }

    return message;
  }

  mergedFrontier(): readonly FrontierDigestEntry[] {
    if (this.localDigest.length === 0) return this.remoteFrontier;
    if (this.remoteFrontier.length === 0) return this.localDigest;

    // Merge local + remote, keeping best value per (metric, cid)
    const index = new Map<string, FrontierDigestEntry>();
    for (const entry of this.localDigest) {
      index.set(`${entry.metric}::${entry.cid}`, entry);
    }
    for (const entry of this.remoteFrontier) {
      const key = `${entry.metric}::${entry.cid}`;
      const existing = index.get(key);
      if (
        !existing ||
        isBetterValue(entry.value, existing.value, entry.direction, existing.direction)
      ) {
        index.set(key, entry);
      }
    }
    return [...index.values()];
  }

  // -------------------------------------------------------------------------
  // Event listeners
  // -------------------------------------------------------------------------

  on(listener: GossipEventListener): void {
    this.listeners.add(listener);
  }

  off(listener: GossipEventListener): void {
    this.listeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Internal: gossip round
  // -------------------------------------------------------------------------

  /** Run a single gossip round (exposed for testing). */
  async runRound(): Promise<void> {
    // 1. Run CYCLON shuffle with oldest peer
    await this.runShuffle();

    // 2. Exchange frontier with fan-out peers
    await this.exchangeWithPeers();

    // 3. Check liveness and emit events
    this.checkLiveness();
  }

  private scheduleNextRound(): void {
    if (!this.running) return;

    const jitter = 1 - this.config.jitter + Math.random() * 2 * this.config.jitter;
    let delay = Math.floor(this.config.intervalMs * jitter);

    // Apply exponential backoff when there are consecutive failures
    if (this.consecutiveFailures > 0) {
      const backoffMultiplier = Math.min(32, 2 ** (this.consecutiveFailures - 1));
      delay *= backoffMultiplier;
    }

    this.timer = setTimeout(async () => {
      try {
        await this.runRound();
        this.consecutiveFailures = 0;
      } catch {
        this.consecutiveFailures++;

        this.emit({
          type: GossipEventType.RoundFailed,
          peerId: this.config.peerId,
          timestamp: new Date(this.now()).toISOString(),
        });

        if (this.consecutiveFailures >= 5) {
          console.warn(
            `Gossip: ${this.consecutiveFailures} consecutive round failures (peer ${this.config.peerId})`,
          );
        }
      }
      this.scheduleNextRound();
    }, delay);
  }

  private async runShuffle(): Promise<void> {
    const target = this.sampler.selectOldestPeer();
    if (!target) return;

    let request: ShuffleRequest = this.sampler.createShuffleRequest(target);
    if (this.config.hmacSecret) {
      request = {
        ...request,
        hmacSignature: signPayload(
          request as unknown as Record<string, unknown>,
          this.config.hmacSecret,
        ),
      };
    }

    try {
      const response = await this.transport.shuffle(target, request);
      this.sampler.processShuffleResponse(response, request.offered);
      this.markAlive(target.peerId);

      // Check for new peers in the response
      for (const peer of response.offered) {
        if (!this.livenessMap.has(peer.peerId) && peer.peerId !== this.config.peerId) {
          this.emit({
            type: GossipEventType.PeerJoined,
            peerId: peer.peerId,
            timestamp: new Date(this.now()).toISOString(),
          });
          this.livenessMap.set(peer.peerId, {
            status: PeerStatus.Alive,
            lastSeen: this.now(),
            suspectedAt: undefined,
          });
        }
      }
    } catch {
      this.markUnresponsive(target.peerId);
    }
  }

  private async exchangeWithPeers(): Promise<void> {
    const view = this.sampler.getView();
    if (view.length === 0) return;

    // Select fan-out peers (random subset of view) via Fisher-Yates shuffle
    const shuffled = [...view];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = shuffled[i];
      shuffled[i] = shuffled[j] as (typeof shuffled)[number];
      shuffled[j] = tmp as (typeof shuffled)[number];
    }
    const targets = shuffled.slice(0, Math.min(this.config.fanOut, shuffled.length));

    const message = await this.currentMessage();

    const exchanges = targets.map(async (peer) => {
      try {
        const response = await this.transport.exchange(peer, message);
        this.markAlive(peer.peerId);
        this.mergeRemoteFrontier(response.frontier);
      } catch {
        this.markUnresponsive(peer.peerId);
      }
    });

    await Promise.allSettled(exchanges);
  }

  // -------------------------------------------------------------------------
  // Internal: frontier digest
  // -------------------------------------------------------------------------

  private async computeDigest(): Promise<FrontierDigestEntry[]> {
    const frontier = await this.frontier.compute({ limit: this.config.digestLimit });
    const entries: FrontierDigestEntry[] = [];

    // Collect top entries from each metric dimension
    for (const [metric, metricEntries] of Object.entries(frontier.byMetric)) {
      for (const entry of metricEntries) {
        const direction = entry.contribution?.scores?.[metric]?.direction;
        entries.push({
          metric,
          value: entry.value,
          cid: entry.cid,
          tags:
            entry.contribution && entry.contribution.tags.length > 0
              ? entry.contribution.tags
              : undefined,
          direction: direction ?? "maximize",
        });
      }
    }

    // Add top entries from other dimensions with synthetic metric names.
    // Synthetic dimensions are always "maximize" (higher = more adoptions,
    // more recent, higher review score, more reproductions).
    const addDimension = (dimension: string, items: readonly FrontierEntry[]): void => {
      for (const entry of items.slice(0, this.config.digestLimit)) {
        entries.push({
          metric: `_${dimension}`,
          value: entry.value,
          cid: entry.cid,
          direction: "maximize",
        });
      }
    };

    addDimension("adoption", frontier.byAdoption);
    addDimension("recency", frontier.byRecency);
    addDimension("review_score", frontier.byReviewScore);
    addDimension("reproduction", frontier.byReproduction);

    // Cap total to stay within the schema limit accepted by peers
    const capped =
      entries.length > MAX_GOSSIP_FRONTIER_ENTRIES
        ? entries.slice(0, MAX_GOSSIP_FRONTIER_ENTRIES)
        : entries;

    // Cache for mergedFrontier()
    this.localDigest = capped;

    return capped;
  }

  private mergeRemoteFrontier(remote: readonly FrontierDigestEntry[]): void {
    // Index existing entries by (metric, cid)
    const index = new Map<string, FrontierDigestEntry>();
    for (const entry of this.remoteFrontier) {
      index.set(`${entry.metric}::${entry.cid}`, entry);
    }

    // Merge: keep the best value per (metric, cid), respecting direction
    for (const entry of remote) {
      const key = `${entry.metric}::${entry.cid}`;
      const existing = index.get(key);
      if (
        !existing ||
        isBetterValue(entry.value, existing.value, entry.direction, existing.direction)
      ) {
        index.set(key, entry);
      }
    }

    let merged = [...index.values()];

    // Evict when over limit — keep "best" entries (direction-aware)
    if (merged.length > MAX_MERGED_FRONTIER_ENTRIES) {
      merged.sort((a, b) => sortValueForEviction(b) - sortValueForEviction(a));
      merged = merged.slice(0, MAX_MERGED_FRONTIER_ENTRIES);
    }

    this.remoteFrontier = merged;

    this.emit({
      type: GossipEventType.FrontierUpdated,
      peerId: this.config.peerId,
      timestamp: new Date(this.now()).toISOString(),
    });
  }

  // -------------------------------------------------------------------------
  // Internal: liveness tracking
  // -------------------------------------------------------------------------

  private markAlive(peerId: string): void {
    const state = this.livenessMap.get(peerId);
    const wasNotAlive = state && state.status !== PeerStatus.Alive;

    this.livenessMap.set(peerId, {
      status: PeerStatus.Alive,
      lastSeen: this.now(),
      suspectedAt: undefined,
    });

    if (wasNotAlive) {
      this.emit({
        type: GossipEventType.PeerRecovered,
        peerId,
        timestamp: new Date(this.now()).toISOString(),
      });
    }
  }

  private markUnresponsive(peerId: string): void {
    const state = this.livenessMap.get(peerId);
    if (!state) {
      this.livenessMap.set(peerId, {
        status: PeerStatus.Suspected,
        lastSeen: this.now(),
        suspectedAt: this.now(),
      });
      return;
    }

    // If already suspected or failed, don't re-mark
    if (state.status === PeerStatus.Suspected || state.status === PeerStatus.Failed) return;

    // Transition: alive → suspected
    this.livenessMap.set(peerId, {
      ...state,
      status: PeerStatus.Suspected,
      suspectedAt: this.now(),
    });

    this.emit({
      type: GossipEventType.PeerSuspected,
      peerId,
      timestamp: new Date(this.now()).toISOString(),
    });
  }

  private checkLiveness(): void {
    const currentTime = this.now();

    for (const [peerId, state] of this.livenessMap) {
      if (peerId === this.config.peerId) continue;

      // Only transition suspected → failed here.
      // The alive → suspected transition happens exclusively via
      // markUnresponsive() when an actual communication attempt fails.
      // This avoids falsely suspecting peers that simply weren't selected
      // for gossip in recent rounds.
      if (state.status === PeerStatus.Suspected) {
        const suspectedDuration = currentTime - (state.suspectedAt ?? currentTime);
        if (suspectedDuration > this.config.failureTimeoutMs - this.config.suspicionTimeoutMs) {
          this.livenessMap.set(peerId, {
            ...state,
            status: PeerStatus.Failed,
          });

          // Remove failed peer from view
          this.sampler.removePeer(peerId);

          this.emit({
            type: GossipEventType.PeerFailed,
            peerId,
            timestamp: new Date(currentTime).toISOString(),
          });
        }
      }
    }
  }

  private emit(event: GossipEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener errors are non-fatal
      }
    }
  }
}
