/**
 * VFS path helpers for Nexus adapters.
 *
 * All Grove data is stored under /zones/{zoneId}/ in the Nexus VFS.
 * These helpers construct consistent paths for each data type.
 */

// ---------------------------------------------------------------------------
// CAS paths
// ---------------------------------------------------------------------------

/** Path to a CAS blob. */
export function casPath(zoneId: string, contentHash: string): string {
  return `/zones/${zoneId}/cas/${contentHash}`;
}

/** Path to a CAS blob metadata sidecar. */
export function casMetaPath(zoneId: string, contentHash: string): string {
  return `/zones/${zoneId}/cas/${contentHash}.meta`;
}

// ---------------------------------------------------------------------------
// Contribution paths
// ---------------------------------------------------------------------------

/** Path to a contribution manifest. */
export function contributionPath(zoneId: string, cid: string): string {
  return `/zones/${zoneId}/contributions/${cid}.json`;
}

/** Directory containing all contributions. */
export function contributionsDir(zoneId: string): string {
  return `/zones/${zoneId}/contributions`;
}

// ---------------------------------------------------------------------------
// Index paths
// ---------------------------------------------------------------------------

/** Path to a tag index marker for a contribution. */
export function tagIndexPath(zoneId: string, tag: string, cid: string): string {
  return `/zones/${zoneId}/indexes/tags/${tag}/${cid}`;
}

/** Directory for a specific tag's index. */
export function tagIndexDir(zoneId: string, tag: string): string {
  return `/zones/${zoneId}/indexes/tags/${tag}`;
}

/** Path to a FTS index entry for a contribution. */
export function ftsIndexPath(zoneId: string, cid: string): string {
  return `/zones/${zoneId}/indexes/fts/${cid}.json`;
}

/** Directory containing all FTS index entries. */
export function ftsIndexDir(zoneId: string): string {
  return `/zones/${zoneId}/indexes/fts`;
}

/** Path to a relation index entry (from source pointing to target). */
export function relationIndexPath(zoneId: string, targetCid: string, sourceCid: string): string {
  return `/zones/${zoneId}/indexes/relations/${targetCid}/${sourceCid}.json`;
}

/** Directory containing all relations pointing to a target. */
export function relationIndexDir(zoneId: string, targetCid: string): string {
  return `/zones/${zoneId}/indexes/relations/${targetCid}`;
}

// ---------------------------------------------------------------------------
// Claim paths
// ---------------------------------------------------------------------------

/**
 * Encode an arbitrary string for safe use as a VFS path segment.
 * Replaces `/` → `%2F`, `%` → `%25` (percent-encode first to avoid collisions).
 */
function encodeSegment(s: string): string {
  return s.replaceAll("%", "%25").replaceAll("/", "%2F");
}

/** Path to a claim JSON file. */
export function claimPath(zoneId: string, claimId: string): string {
  return `/zones/${zoneId}/claims/${encodeSegment(claimId)}.json`;
}

/** Directory containing all claims. */
export function claimsDir(zoneId: string): string {
  return `/zones/${zoneId}/claims`;
}

/** Decode a VFS path segment back to the original string. */
export function decodeSegment(segment: string): string {
  return segment.replaceAll("%2F", "/").replaceAll("%25", "%");
}

/** Path to an active claim index marker. */
export function activeClaimIndexPath(zoneId: string, targetRef: string, claimId: string): string {
  return `/zones/${zoneId}/indexes/claims/active/${encodeSegment(targetRef)}/${encodeSegment(claimId)}`;
}

/** Directory for active claims on a specific target. */
export function activeClaimTargetDir(zoneId: string, targetRef: string): string {
  return `/zones/${zoneId}/indexes/claims/active/${encodeSegment(targetRef)}`;
}

/** Directory for all active claim indexes. */
export function activeClaimsDir(zoneId: string): string {
  return `/zones/${zoneId}/indexes/claims/active`;
}

/**
 * Path to a per-target lock file that enforces the one-active-claim-per-target invariant.
 * Written with ifNoneMatch="*" for atomic exclusivity; content is the owning claimId.
 */
export function targetLockPath(zoneId: string, targetRef: string): string {
  return `/zones/${zoneId}/indexes/claims/target-lock/${encodeSegment(targetRef)}`;
}

// ---------------------------------------------------------------------------
// Outcome paths
// ---------------------------------------------------------------------------

/** Path to an outcome record JSON file. */
export function outcomePath(zoneId: string, cid: string): string {
  return `/zones/${zoneId}/outcomes/${encodeSegment(cid)}.json`;
}

/** Directory containing all outcome records. */
export function outcomesDir(zoneId: string): string {
  return `/zones/${zoneId}/outcomes`;
}

/** Path to an outcome status index marker. */
export function outcomeStatusIndexPath(zoneId: string, status: string, cid: string): string {
  return `/zones/${zoneId}/indexes/outcomes/status/${encodeSegment(status)}/${encodeSegment(cid)}`;
}

/** Directory for a specific outcome status index. */
export function outcomeStatusIndexDir(zoneId: string, status: string): string {
  return `/zones/${zoneId}/indexes/outcomes/status/${encodeSegment(status)}`;
}
