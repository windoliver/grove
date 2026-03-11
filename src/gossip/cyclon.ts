/**
 * Simplified CYCLON peer sampling.
 *
 * Implements the core CYCLON algorithm (Voulgaris et al., 2005) with
 * simplifications appropriate for HTTP-based grove-server federation:
 *
 * - Maintains a bounded partial view of peer servers
 * - Each round: ages all entries, selects oldest, shuffles with it
 * - Supports seed peers for initial bootstrap
 * - O(log N) convergence for overlay construction
 *
 * The full CYCLON paper uses UDP and cache replacement; this version
 * uses HTTP and a simpler merge strategy suitable for <500 nodes.
 */

import type { PeerInfo, ShuffleRequest, ShuffleResponse } from "../core/gossip/types.js";

/** Configuration for the CYCLON peer sampler. */
export interface CyclonConfig {
  /** Maximum entries in the partial view. */
  readonly maxViewSize: number;
  /** Number of entries exchanged per shuffle (including self). */
  readonly shuffleLength: number;
}

/**
 * CYCLON peer sampler.
 *
 * Maintains a partial view of peers with age-based rotation. Peers
 * are selected for shuffle by age (oldest first), and entries are
 * exchanged to maintain a uniform random overlay.
 */
export class CyclonPeerSampler {
  private readonly config: CyclonConfig;
  private readonly selfPeer: PeerInfo;
  private view: PeerInfo[];

  constructor(selfPeer: PeerInfo, config: CyclonConfig, initialPeers?: readonly PeerInfo[]) {
    this.selfPeer = selfPeer;
    this.config = config;

    // Filter out self and duplicates, truncate to maxViewSize
    const seen = new Set<string>([selfPeer.peerId]);
    const filtered: PeerInfo[] = [];
    if (initialPeers) {
      for (const peer of initialPeers) {
        if (!seen.has(peer.peerId)) {
          seen.add(peer.peerId);
          filtered.push(peer);
        }
      }
    }
    this.view = filtered.slice(0, config.maxViewSize);
  }

  /** Get the current partial view (readonly snapshot). */
  getView(): readonly PeerInfo[] {
    return this.view;
  }

  /** Number of peers in the view. */
  get size(): number {
    return this.view.length;
  }

  /**
   * Age all entries and return the oldest peer for the next shuffle.
   *
   * Returns undefined if the view is empty (no peers to shuffle with).
   */
  selectOldestPeer(): PeerInfo | undefined {
    if (this.view.length === 0) return undefined;

    // Increment age of all entries (immutable update)
    this.view = this.view.map((p) => ({ ...p, age: p.age + 1 }));

    // Find the oldest (view is non-empty, checked above)
    let oldest = this.view[0] as PeerInfo;
    for (let i = 1; i < this.view.length; i++) {
      const peer = this.view[i] as PeerInfo;
      if (peer.age > oldest.age) {
        oldest = peer;
      }
    }

    return oldest;
  }

  /**
   * Create a shuffle request to send to a target peer.
   *
   * Includes self (with age 0) and a random subset of the view,
   * excluding the target peer.
   */
  createShuffleRequest(target: PeerInfo): ShuffleRequest {
    // Candidates: view entries excluding the target
    const candidates = this.view.filter((p) => p.peerId !== target.peerId);
    const randomSubset = shuffleArray(candidates).slice(0, this.config.shuffleLength - 1);

    return {
      sender: { ...this.selfPeer, age: 0 },
      offered: [{ ...this.selfPeer, age: 0 }, ...randomSubset],
    };
  }

  /**
   * Handle an incoming shuffle request.
   *
   * Selects entries from our view to send back, then merges the
   * received entries into our view.
   */
  handleShuffleRequest(request: ShuffleRequest): ShuffleResponse {
    const receivedIds = new Set(request.offered.map((p) => p.peerId));

    // Select entries to send back (excluding sender and offered entries)
    const candidates = this.view.filter(
      (p) => p.peerId !== request.sender.peerId && !receivedIds.has(p.peerId),
    );
    const toSend = shuffleArray(candidates).slice(0, request.offered.length);

    // Merge received entries into view
    this.mergeEntries(request.offered, toSend);

    return { offered: toSend };
  }

  /**
   * Process a shuffle response after sending a request.
   *
   * Merges the received entries into our view, replacing entries
   * we sent to the peer.
   */
  processShuffleResponse(response: ShuffleResponse, sentEntries: readonly PeerInfo[]): void {
    this.mergeEntries(response.offered, sentEntries);
  }

  /** Add a single peer to the view (e.g., from seed list or join announcement). */
  addPeer(peer: PeerInfo): boolean {
    if (peer.peerId === this.selfPeer.peerId) return false;
    if (this.view.some((p) => p.peerId === peer.peerId)) return false;
    if (this.view.length >= this.config.maxViewSize) return false;

    this.view.push(peer);
    return true;
  }

  /** Remove a peer from the view (e.g., declared failed). */
  removePeer(peerId: string): boolean {
    const before = this.view.length;
    this.view = this.view.filter((p) => p.peerId !== peerId);
    return this.view.length < before;
  }

  /** Check if a peer is in the view. */
  hasPeer(peerId: string): boolean {
    return this.view.some((p) => p.peerId === peerId);
  }

  /**
   * Merge received entries into the view.
   *
   * Strategy:
   * 1. Skip entries pointing to self
   * 2. Update existing entries if the received entry is fresher (lower age)
   * 3. Replace entries that were sent to the peer
   * 4. Fill remaining capacity
   * 5. If full, replace the oldest entry if received entry is fresher
   */
  private mergeEntries(received: readonly PeerInfo[], sent: readonly PeerInfo[]): void {
    const sentIds = new Set(sent.map((p) => p.peerId));

    for (const entry of received) {
      // Never add self
      if (entry.peerId === this.selfPeer.peerId) continue;

      // If already in view, update if fresher
      const existingIdx = this.view.findIndex((p) => p.peerId === entry.peerId);
      if (existingIdx >= 0) {
        const existing = this.view[existingIdx] as PeerInfo;
        if (entry.age < existing.age) {
          this.view[existingIdx] = entry;
        }
        continue;
      }

      // Try to replace a sent entry
      const sentIdx = this.view.findIndex((p) => sentIds.has(p.peerId));
      if (sentIdx >= 0) {
        const replaced = this.view[sentIdx] as PeerInfo;
        sentIds.delete(replaced.peerId);
        this.view[sentIdx] = entry;
        continue;
      }

      // If under capacity, just add
      if (this.view.length < this.config.maxViewSize) {
        this.view.push(entry);
        continue;
      }

      // View full: replace oldest if this entry is fresher
      let oldestEntry = this.view[0] as PeerInfo;
      let oldestIdx = 0;
      for (let i = 1; i < this.view.length; i++) {
        const peer = this.view[i] as PeerInfo;
        if (peer.age > oldestEntry.age) {
          oldestEntry = peer;
          oldestIdx = i;
        }
      }
      if (entry.age < oldestEntry.age) {
        this.view[oldestIdx] = entry;
      }
    }
  }
}

/** Fisher-Yates shuffle (returns a new array, does not mutate input). */
function shuffleArray<T>(arr: readonly T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const ri = result[i] as T;
    const rj = result[j] as T;
    [result[i], result[j]] = [rj, ri];
  }
  return result;
}
