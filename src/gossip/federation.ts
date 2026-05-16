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
import { MAX_REQUEST_SIZE } from "../core/constants.js";
import type {
  FetchContributionResult,
  FrontierDigestEntry,
  GossipTransport,
  PeerInfo,
} from "../core/gossip/types.js";
import { fromManifest } from "../core/manifest.js";
import type { Contribution } from "../core/models.js";
import type { ContributionStore } from "../core/store.js";

const HASH_PREFIX = "blake3:";

/**
 * Hard cap on artifacts per contribution. Bounds the work a malicious peer
 * can ask us to do per fetch — without this, a peer could advertise a
 * manifest declaring thousands of artifact hashes and force that many peer
 * round-trips + CAS writes before the manifest is even durable.
 */
const MAX_ARTIFACTS_PER_CONTRIBUTION = 64;

/**
 * Hard cap on cumulative bytes fetched per contribution. Without this, a
 * peer could advertise a manifest with N near-cap artifacts and force the
 * server to download N × MAX_REQUEST_SIZE of data before the contribution
 * is even persisted. Cap parity with direct contribution submission.
 */
const MAX_FEDERATION_CUMULATIVE_BYTES = MAX_REQUEST_SIZE;

/**
 * Hard cap on the size of a fetched contribution manifest. Manifests are
 * mostly metadata (CID, scores, agent identity, relations); the strings
 * that can grow unbounded — context, description — should still fit in
 * a small budget. 1 MB is far above realistic manifests and far below
 * the per-artifact 50 MB cap, so a peer can't force the server to buffer
 * tens of megabytes of JSON before fromManifest() runs.
 */
const MAX_MANIFEST_BYTES = 1 * 1024 * 1024;

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
        const manifestRaw = await this.opts.transport.fetchContribution(
          peer,
          cid,
          MAX_MANIFEST_BYTES,
        );
        if (!manifestRaw) {
          errors.push(`${peer.peerId}: 404`);
          continue;
        }
        // Validate manifest schema + recompute CID from the canonical
        // serialization BEFORE any side effects. A peer that advertised cid
        // could otherwise return a poisoned manifest whose JSON happens to
        // include `"cid": "<advertised>"` but whose canonical hash differs;
        // a string-equality check on the raw field is not enough.
        let manifest: Contribution;
        try {
          manifest = fromManifest(manifestRaw, { verify: true });
        } catch (err) {
          errors.push(
            `${peer.peerId}: invalid manifest (${err instanceof Error ? err.message : String(err)})`,
          );
          continue;
        }
        if (manifest.cid !== cid) {
          errors.push(`${peer.peerId}: manifest cid mismatch`);
          continue;
        }
        const artifacts: Record<string, string> = { ...manifest.artifacts };
        const artifactEntries = Object.entries(artifacts);
        if (artifactEntries.length > MAX_ARTIFACTS_PER_CONTRIBUTION) {
          errors.push(
            `${peer.peerId}: manifest declares ${artifactEntries.length} artifacts > cap ${MAX_ARTIFACTS_PER_CONTRIBUTION}`,
          );
          continue;
        }
        let cumulativeBytes = 0;
        for (const [name, declaredHash] of artifactEntries) {
          if (await this.opts.cas.exists(declaredHash)) continue;
          const remaining = MAX_FEDERATION_CUMULATIVE_BYTES - cumulativeBytes;
          if (remaining <= 0) {
            throw new Error(
              `cumulative artifact bytes ${cumulativeBytes} exceeds per-contribution budget ${MAX_FEDERATION_CUMULATIVE_BYTES}`,
            );
          }
          // Pass the remaining per-contribution budget so the transport can
          // short-circuit (Content-Length + streamed cap) before downloading
          // bytes that would push us past the budget.
          const bytes = await this.opts.transport.fetchArtifact(peer, cid, name, remaining);
          if (!bytes) {
            throw new Error(`artifact ${name} (${declaredHash}) missing on ${peer.peerId}`);
          }
          cumulativeBytes += bytes.byteLength;
          if (cumulativeBytes > MAX_FEDERATION_CUMULATIVE_BYTES) {
            throw new Error(
              `cumulative artifact bytes ${cumulativeBytes} exceeds per-contribution budget ${MAX_FEDERATION_CUMULATIVE_BYTES}`,
            );
          }
          const actual = blake3Of(bytes);
          if (actual !== declaredHash) {
            throw new Error(
              `hash mismatch for artifact ${name} on ${peer.peerId}: declared=${declaredHash} actual=${actual}`,
            );
          }
          // Content-addressed store: idempotent put. We do NOT roll back
          // these writes on a later failure — under concurrency we cannot
          // distinguish a blob we just wrote from one another in-flight
          // fetch or direct upload committed at the same hash. Deleting
          // would risk breaking an already-committed contribution that
          // references the same blob. Orphan CAS entries are acceptable;
          // garbage collection sweeps reference-based reachability.
          await this.opts.cas.put(bytes);
        }
        await this.opts.contributionStore.put(manifest);
        // Defend against dedup paths: some stores treat identical logical
        // content under a different CID as a duplicate and don't write
        // the new manifest. After put, verify the requested CID is now
        // resolvable; otherwise federation would silently lie ("ok" but
        // /api/contributions/:cid still 404s) and anti-entropy would
        // refetch indefinitely.
        const persisted = await this.opts.contributionStore.get(cid);
        if (!persisted) {
          throw new Error(
            `contribution ${cid} not present after put (likely deduped against existing content-hash)`,
          );
        }
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
   * Metrics without an entry here pass through unfiltered (including the
   * synthetic dimensions named with a "_" prefix).
   */
  readonly thresholds: Readonly<Record<string, number>>;
  /**
   * Per-CID negative cache. CIDs present in this set are skipped for the
   * current sweep without contacting any peer. The caller is responsible
   * for inserting on failure and expiring entries.
   */
  readonly negativeCache?: Set<string>;
  /**
   * Hook invoked with the sweep result for each attempted CID. Lets the
   * caller emit telemetry (logs, metrics) and update the negative cache.
   * Called once per CID — exceptions are swallowed so the sweep loop
   * always drains its target list.
   */
  readonly onResult?: (result: FetchContributionResult) => void;
}

/**
 * Run a single anti-entropy sweep: walk the merged frontier, pick CIDs that
 * meet per-metric thresholds (and aren't already negatively cached or
 * already requested in this sweep), and ask the federation fetcher to pull
 * them. Each result is forwarded to `onResult` so the caller can log
 * failures and update the negative cache.
 */
export async function runAntiEntropySweep(opts: AntiEntropySweepOpts): Promise<void> {
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const entry of opts.frontier) {
    if (targets.length >= opts.batchSize) break;
    if (seen.has(entry.cid)) continue;
    if (opts.negativeCache?.has(entry.cid)) continue;
    const threshold = opts.thresholds[entry.metric];
    if (threshold !== undefined && entry.value < threshold) continue;
    seen.add(entry.cid);
    targets.push(entry.cid);
  }
  for (const cid of targets) {
    let result: FetchContributionResult;
    try {
      result = await opts.fetcher.fetchRemoteContribution(cid);
    } catch (err) {
      result = {
        kind: "failed",
        cid,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    if (opts.onResult) {
      try {
        opts.onResult(result);
      } catch {
        // Telemetry callback must not break the sweep.
      }
    }
  }
}
