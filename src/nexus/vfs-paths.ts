/**
 * VFS path helpers for Nexus adapters.
 *
 * All Grove data is stored under /zones/{zoneId}/ in the Nexus VFS.
 * These helpers construct consistent paths for each data type.
 */

// ---------------------------------------------------------------------------
// Segment encoding
// ---------------------------------------------------------------------------

/**
 * Encode an arbitrary string for safe use as a VFS path segment.
 * Replaces `%` → `%25`, `/` → `%2F` (percent-encode first to avoid collisions).
 */
export function encodeSegment(s: string): string {
  return s.replaceAll("%", "%25").replaceAll("/", "%2F");
}

/** Decode a VFS path segment back to the original string. */
export function decodeSegment(segment: string): string {
  return segment.replaceAll("%2F", "/").replaceAll("%25", "%");
}

// ---------------------------------------------------------------------------
// CAS paths
// ---------------------------------------------------------------------------

/** Path to a CAS blob. */
export function casPath(zoneId: string, contentHash: string): string {
  return `/zones/${encodeSegment(zoneId)}/cas/${encodeSegment(contentHash)}`;
}

/** Path to a CAS blob metadata sidecar. */
export function casMetaPath(zoneId: string, contentHash: string): string {
  return `/zones/${encodeSegment(zoneId)}/cas/${encodeSegment(contentHash)}.meta`;
}

// ---------------------------------------------------------------------------
// Contribution paths
// ---------------------------------------------------------------------------

/** Path to a contribution manifest. */
export function contributionPath(zoneId: string, cid: string): string {
  return `/zones/${encodeSegment(zoneId)}/contributions/${encodeSegment(cid)}.json`;
}

/** Directory containing all contributions. */
export function contributionsDir(zoneId: string): string {
  return `/zones/${encodeSegment(zoneId)}/contributions`;
}

// ---------------------------------------------------------------------------
// Index paths
// ---------------------------------------------------------------------------

/** Path to a tag index marker for a contribution. */
export function tagIndexPath(zoneId: string, tag: string, cid: string): string {
  return `/zones/${encodeSegment(zoneId)}/indexes/tags/${encodeSegment(tag)}/${encodeSegment(cid)}`;
}

/** Directory for a specific tag's index. */
export function tagIndexDir(zoneId: string, tag: string): string {
  return `/zones/${encodeSegment(zoneId)}/indexes/tags/${encodeSegment(tag)}`;
}

/** Path to a FTS index entry for a contribution. */
export function ftsIndexPath(zoneId: string, cid: string): string {
  return `/zones/${encodeSegment(zoneId)}/indexes/fts/${encodeSegment(cid)}.json`;
}

/** Directory containing all FTS index entries. */
export function ftsIndexDir(zoneId: string): string {
  return `/zones/${encodeSegment(zoneId)}/indexes/fts`;
}

/** Path to a relation index entry (from source pointing to target). */
export function relationIndexPath(zoneId: string, targetCid: string, sourceCid: string): string {
  return `/zones/${encodeSegment(zoneId)}/indexes/relations/${encodeSegment(targetCid)}/${encodeSegment(sourceCid)}.json`;
}

/** Directory containing all relations pointing to a target. */
export function relationIndexDir(zoneId: string, targetCid: string): string {
  return `/zones/${encodeSegment(zoneId)}/indexes/relations/${encodeSegment(targetCid)}`;
}

// ---------------------------------------------------------------------------
// Claim paths
// ---------------------------------------------------------------------------

/** Path to a claim JSON file. */
export function claimPath(zoneId: string, claimId: string): string {
  return `/zones/${encodeSegment(zoneId)}/claims/${encodeSegment(claimId)}.json`;
}

/** Directory containing all claims. */
export function claimsDir(zoneId: string): string {
  return `/zones/${encodeSegment(zoneId)}/claims`;
}

/** Path to an active claim index marker. */
export function activeClaimIndexPath(zoneId: string, targetRef: string, claimId: string): string {
  return `/zones/${encodeSegment(zoneId)}/indexes/claims/active/${encodeSegment(targetRef)}/${encodeSegment(claimId)}`;
}

/** Directory for active claims on a specific target. */
export function activeClaimTargetDir(zoneId: string, targetRef: string): string {
  return `/zones/${encodeSegment(zoneId)}/indexes/claims/active/${encodeSegment(targetRef)}`;
}

/** Directory for all active claim indexes. */
export function activeClaimsDir(zoneId: string): string {
  return `/zones/${encodeSegment(zoneId)}/indexes/claims/active`;
}

/**
 * Path to a per-target lock file that enforces the one-active-claim-per-target invariant.
 * Written with ifNoneMatch="*" for atomic exclusivity; content is the owning claimId.
 */
export function targetLockPath(zoneId: string, targetRef: string): string {
  return `/zones/${encodeSegment(zoneId)}/indexes/claims/target-lock/${encodeSegment(targetRef)}`;
}

// ---------------------------------------------------------------------------
// Bounty paths
// ---------------------------------------------------------------------------

/** Path to a bounty JSON file. */
export function bountyPath(zoneId: string, bountyId: string): string {
  return `/zones/${encodeSegment(zoneId)}/bounties/${encodeSegment(bountyId)}.json`;
}

/** Directory containing all bounties. */
export function bountiesDir(zoneId: string): string {
  return `/zones/${encodeSegment(zoneId)}/bounties`;
}

/** Path to a bounty status index marker. */
export function bountyStatusIndexPath(zoneId: string, status: string, bountyId: string): string {
  return `/zones/${encodeSegment(zoneId)}/indexes/bounties/status/${encodeSegment(status)}/${encodeSegment(bountyId)}`;
}

/** Directory for a specific bounty status index. */
export function bountyStatusIndexDir(zoneId: string, status: string): string {
  return `/zones/${encodeSegment(zoneId)}/indexes/bounties/status/${encodeSegment(status)}`;
}

// ---------------------------------------------------------------------------
// Outcome paths
// ---------------------------------------------------------------------------

/** Path to an outcome record JSON file. */
export function outcomePath(zoneId: string, cid: string): string {
  return `/zones/${encodeSegment(zoneId)}/outcomes/${encodeSegment(cid)}.json`;
}

/** Directory containing all outcome records. */
export function outcomesDir(zoneId: string): string {
  return `/zones/${encodeSegment(zoneId)}/outcomes`;
}

/** Path to an outcome status index marker. */
export function outcomeStatusIndexPath(zoneId: string, status: string, cid: string): string {
  return `/zones/${encodeSegment(zoneId)}/indexes/outcomes/status/${encodeSegment(status)}/${encodeSegment(cid)}`;
}

/** Directory for a specific outcome status index. */
export function outcomeStatusIndexDir(zoneId: string, status: string): string {
  return `/zones/${encodeSegment(zoneId)}/indexes/outcomes/status/${encodeSegment(status)}`;
}
