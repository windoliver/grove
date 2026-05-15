/**
 * Federation fetcher: pulls remote contributions + artifacts from gossip peers
 * and verifies BLAKE3 content hashes before persisting locally (#226).
 *
 * Lives outside protocol.ts to keep the orchestration concern (HTTP fetch,
 * hash verification, peer fallback) separate from the gossip-state concern
 * (frontier merge, peer sampling, liveness).
 */

import { hash as blake3Hash } from "blake3";

import type { ContentStore } from "../core/cas.js";
import type {
  FetchContributionResult,
  FrontierDigestEntry,
  GossipTransport,
  PeerInfo,
} from "../core/gossip/types.js";
import type { Contribution } from "../core/models.js";
import type { ContributionStore } from "../core/store.js";

const HASH_PREFIX = "blake3:";

function blake3Of(bytes: Uint8Array): string {
  return `${HASH_PREFIX}${blake3Hash(bytes).toString("hex")}`;
}

export interface FederationFetcherOpts {
  readonly contributionStore: ContributionStore;
  readonly cas: ContentStore;
  readonly transport: GossipTransport;
  /** Resolve the peers known to have advertised this CID. */
  readonly peersFor: (cid: string) => readonly PeerInfo[];
}

export class FederationFetcher {
  constructor(private readonly opts: FederationFetcherOpts) {}

  async fetchRemoteContribution(cid: string): Promise<FetchContributionResult> {
    const existing = await this.opts.contributionStore.get(cid);
    if (existing) return { kind: "already-local", cid };

    const peers = this.opts.peersFor(cid);
    if (peers.length === 0) return { kind: "no-source", cid };

    const errors: string[] = [];
    for (const peer of peers) {
      try {
        const manifestRaw = await this.opts.transport.fetchContribution(peer, cid);
        if (!manifestRaw) {
          errors.push(`${peer.peerId}: 404`);
          continue;
        }
        const manifest = manifestRaw as Contribution;
        if (manifest.cid !== cid) {
          errors.push(`${peer.peerId}: manifest cid mismatch`);
          continue;
        }
        const artifacts: Record<string, string> = manifest.artifacts ?? {};
        for (const [name, declaredHash] of Object.entries(artifacts)) {
          if (await this.opts.cas.exists(declaredHash)) continue;
          const bytes = await this.opts.transport.fetchArtifact(peer, declaredHash);
          if (!bytes) {
            throw new Error(`artifact ${name} (${declaredHash}) missing on ${peer.peerId}`);
          }
          const actual = blake3Of(bytes);
          if (actual !== declaredHash) {
            throw new Error(
              `hash mismatch for artifact ${name} on ${peer.peerId}: declared=${declaredHash} actual=${actual}`,
            );
          }
          await this.opts.cas.put(bytes);
        }
        await this.opts.contributionStore.put(manifest);
        return { kind: "ok", cid };
      } catch (err) {
        errors.push(`${peer.peerId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { kind: "failed", cid, reason: errors.join("; ") };
  }
}

export interface AntiEntropySweepOpts {
  readonly frontier: readonly FrontierDigestEntry[];
  readonly fetcher: FederationFetcher;
  readonly batchSize: number;
  /**
   * Map of metric → minimum value. Entries below the threshold are skipped.
   * Synthetic metrics (prefix "_") default to 0 if unspecified.
   */
  readonly thresholds: Readonly<Record<string, number>>;
}

/**
 * Run a single anti-entropy sweep: walk the merged frontier, pick CIDs that
 * meet per-metric thresholds (and aren't already requested in this sweep),
 * and ask the federation fetcher to pull them. Best-effort — individual fetch
 * failures are swallowed (the fetcher already reports per-peer errors).
 */
export async function runAntiEntropySweep(opts: AntiEntropySweepOpts): Promise<void> {
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const entry of opts.frontier) {
    if (targets.length >= opts.batchSize) break;
    if (seen.has(entry.cid)) continue;
    const threshold = opts.thresholds[entry.metric];
    if (threshold !== undefined && entry.value < threshold) continue;
    seen.add(entry.cid);
    targets.push(entry.cid);
  }
  for (const cid of targets) {
    try {
      await opts.fetcher.fetchRemoteContribution(cid);
    } catch {
      // Sweep is best-effort; individual fetch failures are logged inside fetcher.
    }
  }
}
