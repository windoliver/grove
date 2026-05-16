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
import type { ContentStore } from "../core/cas.js";
import type { FrontierCalculator, FrontierEntry } from "../core/frontier.js";
import {
  type FetchContributionResult,
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
import type { ContributionStore } from "../core/store.js";
import { CyclonPeerSampler } from "./cyclon.js";
import { FederationFetcher, runAntiEntropySweep } from "./federation.js";

/** Maximum age of a signed gossip message before it is rejected as a potential replay. */
const GOSSIP_MAX_MESSAGE_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Hard cap on peers tracked per CID in the advertisement map. Beyond the
 * implicit bound from CYCLON's partial-view size, this prevents transient
 * view churn from accumulating stale advertisers. Keeps federation fetch
 * fallback latency bounded regardless of network behavior.
 */
const MAX_ADVERTISERS_PER_CID = 16;

/**
 * Thrown by handleExchange/handleShuffle when HMAC verification or freshness
 * checks fail. Callers (HTTP routes, daemon handlers) must catch this and
 * return 401/403 — never leak gossip state to an unauthenticated peer.
 */
export class GossipAuthError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "GossipAuthError";
  }
}

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
export function signPayload(payload: Record<string, unknown>, secret: string): string {
  const { hmacSignature: _, ...data } = payload;
  const hmac = createHmac("sha256", secret);
  hmac.update(JSON.stringify(data));
  return hmac.digest("hex");
}

/** Verify HMAC-SHA256 signature on a payload using timing-safe comparison. */
export function verifyPayload(
  payload: Record<string, unknown> & { hmacSignature?: string },
  secret: string,
): boolean {
  const sig = payload.hmacSignature;
  if (!sig) return false;
  // Reject non-hex or wrong-length signatures before calling timingSafeEqual.
  // timingSafeEqual throws RangeError when buffer byte lengths differ, which
  // happens when non-ASCII characters make a 64-char string longer than 64 bytes.
  if (!/^[0-9a-f]{64}$/i.test(sig)) return false;
  const expected = signPayload(payload, secret);
  return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
}

/**
 * Headers used to authenticate peer-to-peer GET requests against
 * content-addressed federation endpoints (#226). The transport signs
 * `${method}\n${path}\n${timestamp}` with the shared HMAC secret; the server
 * verifies before exempting the request from namespace bearer auth.
 */
export const GOSSIP_GET_TIMESTAMP_HEADER = "x-gossip-timestamp";
export const GOSSIP_GET_SIGNATURE_HEADER = "x-gossip-signature";

/** Compute HMAC-SHA256 over the canonical "method\npath\ntimestamp" string. */
export function signGetRequest(
  method: string,
  path: string,
  timestamp: string,
  secret: string,
): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(`${method.toUpperCase()}\n${path}\n${timestamp}`);
  return hmac.digest("hex");
}

/**
 * Verify a peer-signed GET request. Returns true when:
 *   - the timestamp is within ±GOSSIP_MAX_MESSAGE_AGE_MS of `nowMs`,
 *   - the signature is well-formed hex,
 *   - the signature matches signGetRequest(method, path, timestamp, secret)
 *     under timing-safe comparison.
 */
export function verifyGetRequest(args: {
  readonly method: string;
  readonly path: string;
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
  readonly secret: string;
  readonly nowMs: number;
}): boolean {
  const { method, path, timestamp, signature, secret, nowMs } = args;
  if (!timestamp || !signature) return false;
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
  const tsMs = Date.parse(timestamp);
  if (!Number.isFinite(tsMs)) return false;
  if (Math.abs(nowMs - tsMs) > GOSSIP_MAX_MESSAGE_AGE_MS) return false;
  const expected = signGetRequest(method, path, timestamp, secret);
  try {
    return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
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
    readonly antiEntropyEnabled: boolean;
    readonly antiEntropyIntervalMs: number;
    readonly antiEntropyBatchSize: number;
    readonly antiEntropyThresholds: Readonly<Record<string, number>>;
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
  private antiEntropyTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Per-CID negative cache used by anti-entropy to throttle re-fetches of
   * known-unfetchable advertisements. Maps cid → expiresAtMs (epoch ms);
   * GC'd lazily on next sweep build.
   */
  private readonly antiEntropyNegativeCache = new Map<string, number>();
  /**
   * Map of cid → (peerId → PeerInfo) for peers that advertised this cid.
   *
   * The outer map is bounded by the number of distinct cids in
   * `remoteFrontier` (≤ {@link MAX_MERGED_FRONTIER_ENTRIES}) — eviction is
   * coupled to the frontier-prune step in {@link mergeRemoteFrontier}. The
   * inner per-cid map is bounded by the partial view size (one entry per
   * peer that has gossiped this cid).
   */
  private readonly advertisements = new Map<string, Map<string, PeerInfo>>();
  private localDigest: FrontierDigestEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private consecutiveFailures = 0;
  private readonly now: () => number;
  /** Per-peer monotonic timestamp (ms) for replay detection. */
  private readonly peerLastTimestamp = new Map<string, number>();
  /**
   * Federation fetcher for pulling remote contributions over gossip.
   * Undefined when the gossip service was constructed without a local
   * contribution store + CAS (e.g., in unit tests that only exercise
   * peer sampling and frontier merge).
   */
  private readonly federation: FederationFetcher | undefined;
  /**
   * Reference to the same contribution store federation reads through.
   * Used by anti-entropy to skip already-local CIDs when filtering
   * sweep candidates so batch slots don't get wasted on `already-local`.
   */
  private readonly contributionStore: ContributionStore | undefined;

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
    /** Local contribution store; required to enable federation features. */
    contributionStore?: ContributionStore;
    /** Local CAS; required to enable federation features. */
    cas?: ContentStore;
  }) {
    const ae = opts.config.antiEntropy;
    // Defensive validation: a NaN / zero / negative interval would make
    // setTimeout fire on every tick and turn gossip into a hot loop. Reject
    // bad values rather than silently melting CPU.
    const validPositiveInt = (n: number | undefined, name: string): number | undefined => {
      if (n === undefined) return undefined;
      if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
        throw new Error(
          `DefaultGossipService: invalid ${name}=${n}; must be a positive integer`,
        );
      }
      return n;
    };
    /**
     * Jitter is a multiplier in [0, 1): scheduleNextRound applies
     *   delay * (1 - jitter + Math.random() * 2 * jitter)
     * which stays positive only when jitter < 1. Anything else risks
     * negative delays (immediate fire).
     */
    const validJitter = (n: number | undefined): number | undefined => {
      if (n === undefined) return undefined;
      if (!Number.isFinite(n) || n < 0 || n >= 1) {
        throw new Error(
          `DefaultGossipService: invalid jitter=${n}; must be a finite number in [0, 1)`,
        );
      }
      return n;
    };
    const intervalMs =
      validPositiveInt(opts.config.intervalMs, "intervalMs") ?? DEFAULT_GOSSIP_INTERVAL_MS;
    const suspicionTimeoutMs =
      validPositiveInt(opts.config.suspicionTimeoutMs, "suspicionTimeoutMs") ??
      DEFAULT_SUSPICION_TIMEOUT_MS;
    const failureTimeoutMs =
      validPositiveInt(opts.config.failureTimeoutMs, "failureTimeoutMs") ??
      DEFAULT_FAILURE_TIMEOUT_MS;
    if (failureTimeoutMs <= suspicionTimeoutMs) {
      throw new Error(
        `DefaultGossipService: failureTimeoutMs (${failureTimeoutMs}) must be > suspicionTimeoutMs (${suspicionTimeoutMs})`,
      );
    }
    this.config = {
      peerId: opts.config.peerId,
      address: opts.config.address,
      intervalMs,
      fanOut:
        validPositiveInt(opts.config.fanOut, "fanOut") ?? DEFAULT_GOSSIP_FAN_OUT,
      jitter: validJitter(opts.config.jitter) ?? DEFAULT_GOSSIP_JITTER,
      digestLimit:
        validPositiveInt(opts.config.digestLimit, "digestLimit") ??
        DEFAULT_FRONTIER_DIGEST_LIMIT,
      suspicionTimeoutMs,
      failureTimeoutMs,
      hmacSecret: opts.config.hmacSecret,
      antiEntropyEnabled: ae?.enabled ?? false,
      antiEntropyIntervalMs:
        validPositiveInt(ae?.intervalMs, "antiEntropy.intervalMs") ?? intervalMs * 5,
      antiEntropyBatchSize:
        validPositiveInt(ae?.batchSize, "antiEntropy.batchSize") ?? 16,
      antiEntropyThresholds: ae?.metricThresholds ?? {},
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

    this.contributionStore = opts.contributionStore;
    // Federation: only enabled when caller provided both store and CAS.
    this.federation =
      opts.contributionStore && opts.cas
        ? new FederationFetcher({
            contributionStore: opts.contributionStore,
            cas: opts.cas,
            transport: opts.transport,
            peersFor: (cid) => this.peersAdvertising(cid),
          })
        : undefined;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNextRound();
    if (this.config.antiEntropyEnabled && this.federation) {
      this.scheduleNextAntiEntropy();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.antiEntropyTimer !== undefined) {
      clearTimeout(this.antiEntropyTimer);
      this.antiEntropyTimer = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Gossip exchange
  // -------------------------------------------------------------------------

  async handleExchange(message: GossipMessage): Promise<GossipMessage> {
    // Verify HMAC if configured
    if (this.config.hmacSecret) {
      if (!verifyPayload(message as unknown as Record<string, unknown>, this.config.hmacSecret)) {
        throw new GossipAuthError(`invalid or missing HMAC from peer ${message.peerId}`);
      }
      // Reject messages outside the 5-minute clock-skew window to prevent replay attacks.
      const msgTimestampMs = new Date(message.timestamp).getTime();
      // NaN bypass guard: an invalid timestamp string (e.g. "not-a-date")
      // makes `getTime()` return NaN, and every NaN comparison (`age > max`,
      // `msgTimestampMs <= lastSeen`) is false — meaning a signed message
      // with a junk timestamp would silently bypass freshness + monotonic
      // replay checks.
      if (!Number.isFinite(msgTimestampMs)) {
        throw new GossipAuthError(
          `invalid timestamp '${message.timestamp}' from peer ${message.peerId}`,
        );
      }
      const age = Math.abs(this.now() - msgTimestampMs);
      if (age > GOSSIP_MAX_MESSAGE_AGE_MS) {
        throw new GossipAuthError(`message too old (${age}ms) from peer ${message.peerId}`);
      }
      // Monotonic timestamp guard: reject replays within the valid window.
      const lastSeen = this.peerLastTimestamp.get(message.peerId);
      if (lastSeen !== undefined && msgTimestampMs <= lastSeen) {
        throw new GossipAuthError(
          `replay detected from peer ${message.peerId} (ts=${msgTimestampMs} <= last=${lastSeen})`,
        );
      }
      this.peerLastTimestamp.set(message.peerId, msgTimestampMs);
    }

    // Update liveness for sender
    this.markAlive(message.peerId);

    // Merge remote frontier entries
    this.mergeRemoteFrontier(message.frontier);

    // Admit the sender to the CYCLON view BEFORE recording advertisements:
    // recordAdvertisements only trusts in-view peers, so the addPeer call
    // must happen first or every advertisement from a fresh peer would be
    // silently dropped.
    if (message.address) {
      const senderPeer: PeerInfo = {
        peerId: message.peerId,
        address: message.address,
        age: 0,
        lastSeen: message.timestamp,
      };
      this.sampler.addPeer(senderPeer);
      this.recordAdvertisements(
        message.peerId,
        message.address,
        message.frontier,
        message.timestamp,
      );
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
      // Reject replayed messages outside the 5-minute clock-skew window.
      const ts = request.sender.lastSeen;
      const senderTs = new Date(ts).getTime();
      if (!Number.isFinite(senderTs)) {
        console.warn(
          `Gossip: rejecting shuffle from ${request.sender.peerId} — invalid timestamp '${ts}'`,
        );
        return { offered: [] };
      }
      const age = Math.abs(this.now() - senderTs);
      if (age > GOSSIP_MAX_MESSAGE_AGE_MS) {
        console.warn(
          `Gossip: rejecting shuffle from ${request.sender.peerId} — message too old (${age}ms)`,
        );
        return { offered: [] };
      }
      // Monotonic timestamp guard on the SIGNED sender timestamp: reject any
      // shuffle whose `sender.lastSeen` is at or before the highest we've
      // already accepted from this peer. This is stricter than a local-clock
      // throttle: a captured signed request cannot be replayed even hours
      // later within the 5-minute skew window. The signed timestamp must
      // strictly advance per peer for forward progress.
      const shuffleKey = `shuffle:${request.sender.peerId}`;
      const lastSenderTs = this.peerLastTimestamp.get(shuffleKey);
      if (lastSenderTs !== undefined && senderTs <= lastSenderTs) {
        console.warn(
          `Gossip: rejecting replayed shuffle from ${request.sender.peerId} (ts=${senderTs} <= last=${lastSenderTs})`,
        );
        return { offered: [] };
      }
      this.peerLastTimestamp.set(shuffleKey, senderTs);
    }

    this.markAlive(request.sender.peerId);
    const response = this.sampler.handleShuffleRequest(request);
    if (this.config.hmacSecret) {
      return {
        ...response,
        hmacSignature: signPayload(
          response as unknown as Record<string, unknown>,
          this.config.hmacSecret,
        ),
      };
    }
    return response;
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
  // CID → advertising peers tracking
  // -------------------------------------------------------------------------

  private recordAdvertisements(
    peerId: string,
    address: string,
    frontier: readonly FrontierDigestEntry[],
    lastSeen: string,
  ): void {
    // Purely additive: never deletes. Eviction is bound to mergeRemoteFrontier
    // (which is the only place that prunes the frontier — and therefore the
    // only place that can cause an advertisement to become orphaned).
    //
    // Filter to cids that survived the merge: an incoming cid that ranked
    // below the eviction cutoff is never recorded in the first place. Without
    // this filter, `peersAdvertising` would expose pruned cids and on-demand
    // fetch could chase entries the frontier already rejected.
    const survivingCids = new Set<string>();
    for (const entry of this.remoteFrontier) survivingCids.add(entry.cid);

    // Trust boundary: only record advertisements from peers that are
    // currently in the CYCLON partial view (or are the bootstrap self
    // entry, never recorded here because peerId !== self). A
    // compromised HMAC peer cannot otherwise spam recordAdvertisements
    // with fresh peerIds for a single CID to bloat advertisements and
    // force federation fetch amplification — addPeer applies CYCLON's
    // maxViewSize cap, which makes the advertisement set bounded by the
    // view size.
    const inView = this.sampler.getView().some((p) => p.peerId === peerId);
    if (!inView) return;

    const peer: PeerInfo = {
      peerId,
      address,
      age: 0,
      lastSeen,
    };
    const currentView = new Set(this.sampler.getView().map((p) => p.peerId));
    for (const entry of frontier) {
      if (!survivingCids.has(entry.cid)) continue;
      let byPeer = this.advertisements.get(entry.cid);
      if (!byPeer) {
        byPeer = new Map();
        this.advertisements.set(entry.cid, byPeer);
      }
      // Refreshing an existing entry is always fine: we just bump lastSeen.
      if (byPeer.has(peerId)) {
        byPeer.set(peerId, peer);
        continue;
      }
      // Per-CID advertiser cap with stale-first eviction so a churn of dead
      // peers can't permanently occupy the cap and freeze out live ones.
      if (byPeer.size >= MAX_ADVERTISERS_PER_CID) {
        // 1) Prefer evicting an advertiser no longer in the CYCLON view.
        // 2) If everyone's in view, evict the oldest by lastSeen.
        let victim: string | undefined;
        for (const [pid] of byPeer) {
          if (!currentView.has(pid)) {
            victim = pid;
            break;
          }
        }
        if (!victim) {
          let oldest = Number.POSITIVE_INFINITY;
          for (const [pid, p] of byPeer) {
            const t = Date.parse(p.lastSeen);
            if (Number.isFinite(t) && t < oldest) {
              oldest = t;
              victim = pid;
            }
          }
        }
        if (!victim) continue; // shouldn't happen; refuse to write rather than corrupt
        byPeer.delete(victim);
      }
      byPeer.set(peerId, peer);
    }
  }

  peersAdvertising(cid: string): readonly PeerInfo[] {
    const byPeer = this.advertisements.get(cid);
    if (!byPeer) return [];
    // Filter against the live CYCLON view so federation fetch only walks
    // peers we still trust. Stale advertisers are kept in the map (they may
    // recover on the next exchange) but are hidden from callers.
    const currentView = new Set(this.sampler.getView().map((p) => p.peerId));
    const live: PeerInfo[] = [];
    for (const [pid, peer] of byPeer) {
      if (currentView.has(pid)) live.push(peer);
    }
    return live;
  }

  async fetchRemoteContribution(cid: string): Promise<FetchContributionResult> {
    if (!this.federation) {
      return { kind: "failed", cid, reason: "federation not configured (missing store or cas)" };
    }
    return this.federation.fetchRemoteContribution(cid);
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

  private scheduleNextAntiEntropy(): void {
    if (!this.running || !this.federation) return;
    const jitter = 1 - this.config.jitter + Math.random() * 2 * this.config.jitter;
    const delay = Math.floor(this.config.antiEntropyIntervalMs * jitter);
    this.antiEntropyTimer = setTimeout(async () => {
      const fetcher = this.federation;
      if (!fetcher) return;
      // Build the live negative-cache set: drop entries whose backoff has
      // expired. Keeps the cache bounded and lets recovered CIDs retry.
      const nowMs = this.now();
      const negative = new Set<string>();
      for (const [cid, expiresAt] of this.antiEntropyNegativeCache) {
        if (expiresAt > nowMs) {
          negative.add(cid);
        } else {
          this.antiEntropyNegativeCache.delete(cid);
        }
      }
      // Negative-cache TTL: hold a failed CID for one full anti-entropy
      // interval so a buggy / malicious peer can't make us redo doomed
      // work every sweep. Recovered peers and resigned advertisements
      // get retried on the next tick after the entry expires.
      const failureTtlMs = this.config.antiEntropyIntervalMs;
      const contributionStore = this.contributionStore;
      try {
        await runAntiEntropySweep({
          frontier: this.mergedFrontier(),
          fetcher,
          batchSize: this.config.antiEntropyBatchSize,
          thresholds: this.config.antiEntropyThresholds,
          negativeCache: negative,
          // Locality predicate: skip CIDs already in the local store so
          // batch slots fill with genuine federation work. Without this,
          // a node whose local frontier exceeds batchSize would chew up
          // every sweep on already-local entries from the merged digest.
          isLocal: contributionStore
            ? async (cid) => (await contributionStore.get(cid)) !== undefined
            : undefined,
          onResult: (result) => {
            switch (result.kind) {
              case "failed":
                this.antiEntropyNegativeCache.set(result.cid, this.now() + failureTtlMs);
                console.warn(
                  `Gossip anti-entropy: fetch failed for ${result.cid}: ${result.reason}`,
                );
                break;
              case "no-source":
                this.antiEntropyNegativeCache.set(result.cid, this.now() + failureTtlMs);
                break;
              case "ok":
              case "already-local":
                // Recovered or no-op — clear any prior negative cache entry.
                this.antiEntropyNegativeCache.delete(result.cid);
                break;
            }
          },
        });
      } catch {
        // best-effort
      }
      this.scheduleNextAntiEntropy();
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
        // Apply the same freshness + monotonic replay checks we apply to
        // incoming exchange requests. The transport verifies the HMAC
        // signature, but a captured-and-replayed signed response would
        // otherwise be merged unconditionally, keeping stale frontier
        // entries and obsolete advertiser addresses alive. When the HMAC
        // secret is not configured we skip these checks (test path).
        if (this.config.hmacSecret) {
          const tsMs = new Date(response.timestamp).getTime();
          if (!Number.isFinite(tsMs)) {
            this.markUnresponsive(peer.peerId);
            return;
          }
          if (Math.abs(this.now() - tsMs) > GOSSIP_MAX_MESSAGE_AGE_MS) {
            this.markUnresponsive(peer.peerId);
            return;
          }
          const lastSeen = this.peerLastTimestamp.get(response.peerId);
          if (lastSeen !== undefined && tsMs <= lastSeen) {
            this.markUnresponsive(peer.peerId);
            return;
          }
          this.peerLastTimestamp.set(response.peerId, tsMs);
        }
        this.markAlive(peer.peerId);
        this.mergeRemoteFrontier(response.frontier);
        if (response.address) {
          this.recordAdvertisements(
            response.peerId,
            response.address,
            response.frontier,
            response.timestamp,
          );
        }
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
      // Eviction-parity: drop advertisements for any cid no longer referenced
      // by *any* surviving (metric, cid) key. Coupling this to the prune step
      // (rather than to recordAdvertisements) eliminates the race where a
      // freshly-recorded advertisement is wiped because its cid ranked below
      // the eviction threshold.
      const survivingCids = new Set<string>();
      for (const entry of merged) survivingCids.add(entry.cid);
      for (const cid of this.advertisements.keys()) {
        if (!survivingCids.has(cid)) this.advertisements.delete(cid);
      }
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
