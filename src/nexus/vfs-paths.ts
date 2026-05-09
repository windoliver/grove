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
// Skill catalog paths
// ---------------------------------------------------------------------------

/** Path to the signed skill catalog index JSON. */
export function skillCatalogIndexPath(zoneId: string): string {
  return `/zones/${encodeSegment(zoneId)}/skill-catalog/index.json`;
}

/** Path to the skill catalog signature sidecar. */
export function skillCatalogSignaturePath(zoneId: string): string {
  return `/zones/${encodeSegment(zoneId)}/skill-catalog/index.sig`;
}

/** Path to an immutable skill bundle ZIP selected by a verified bundle hash. */
export function skillCatalogBundlePath(zoneId: string, bundleHash: string): string {
  return `/zones/${encodeSegment(zoneId)}/skill-catalog/bundles/${encodeSegment(bundleHash)}.zip`;
}

// ---------------------------------------------------------------------------
// Contribution paths
// ---------------------------------------------------------------------------

/** Path to a contribution manifest. */
export function contributionPath(zoneId: string, cid: string, sessionId?: string): string {
  const base = sessionId
    ? `/zones/${encodeSegment(zoneId)}/sessions/${encodeSegment(sessionId)}`
    : `/zones/${encodeSegment(zoneId)}`;
  return `${base}/contributions/${encodeSegment(cid)}.json`;
}

/** Directory containing all contributions. */
export function contributionsDir(zoneId: string, sessionId?: string): string {
  const base = sessionId
    ? `/zones/${encodeSegment(zoneId)}/sessions/${encodeSegment(sessionId)}`
    : `/zones/${encodeSegment(zoneId)}`;
  return `${base}/contributions`;
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
export function ftsIndexPath(zoneId: string, cid: string, sessionId?: string): string {
  const base = sessionId
    ? `/zones/${encodeSegment(zoneId)}/sessions/${encodeSegment(sessionId)}`
    : `/zones/${encodeSegment(zoneId)}`;
  return `${base}/indexes/fts/${encodeSegment(cid)}.json`;
}

/** Directory containing all FTS index entries. */
export function ftsIndexDir(zoneId: string, sessionId?: string): string {
  const base = sessionId
    ? `/zones/${encodeSegment(zoneId)}/sessions/${encodeSegment(sessionId)}`
    : `/zones/${encodeSegment(zoneId)}`;
  return `${base}/indexes/fts`;
}

/** Path to a contribution content-hash dedup index marker. */
export function contributionContentHashIndexPath(
  zoneId: string,
  contentHash: string,
  sessionId?: string,
): string {
  const base = sessionId
    ? `/zones/${encodeSegment(zoneId)}/sessions/${encodeSegment(sessionId)}`
    : `/zones/${encodeSegment(zoneId)}`;
  return `${base}/indexes/contributions/content-hash/${encodeSegment(contentHash)}`;
}

function zoneDataBase(zoneId: string, sessionId?: string): string {
  return sessionId
    ? `/zones/${encodeSegment(zoneId)}/sessions/${encodeSegment(sessionId)}`
    : `/zones/${encodeSegment(zoneId)}`;
}

function contributionIndexBase(zoneId: string, sessionId?: string): string {
  return `${zoneDataBase(zoneId, sessionId)}/indexes/contributions`;
}

function createdAtBucket(createdAt: string): string {
  const date = new Date(createdAt);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  return `${year}/${month}/${day}/${hour}`;
}

function createdAtEntryName(createdAt: string, cid: string): string {
  const timestamp = String(new Date(createdAt).getTime()).padStart(13, "0");
  return `${timestamp}-${encodeSegment(cid)}`;
}

/** Directory containing created-at contribution index buckets. */
export function contributionCreatedAtIndexRootDir(zoneId: string, sessionId?: string): string {
  return `${contributionIndexBase(zoneId, sessionId)}/created-at`;
}

/** Marker written after created-at contribution indexes have been backfilled. */
export function contributionCreatedAtIndexReadyPath(zoneId: string, sessionId?: string): string {
  return `${contributionCreatedAtIndexRootDir(zoneId, sessionId)}/.ready`;
}

/** Directory for a UTC-hour created-at contribution index bucket. */
export function contributionCreatedAtIndexBucketDir(
  zoneId: string,
  bucket: string,
  sessionId?: string,
): string {
  return `${contributionCreatedAtIndexRootDir(zoneId, sessionId)}/${bucket}`;
}

/** Path to a created-at contribution index marker. */
export function contributionCreatedAtIndexPath(
  zoneId: string,
  createdAt: string,
  cid: string,
  sessionId?: string,
): string {
  return `${contributionCreatedAtIndexBucketDir(zoneId, createdAtBucket(createdAt), sessionId)}/${createdAtEntryName(createdAt, cid)}`;
}

/** Directory containing created-at contribution index buckets for an agent. */
export function contributionAgentCreatedAtIndexRootDir(
  zoneId: string,
  agentId: string,
  sessionId?: string,
): string {
  return `${contributionIndexBase(zoneId, sessionId)}/agents/${encodeSegment(agentId)}/created-at`;
}

/** Directory for a UTC-hour created-at contribution index bucket for an agent. */
export function contributionAgentCreatedAtIndexBucketDir(
  zoneId: string,
  agentId: string,
  bucket: string,
  sessionId?: string,
): string {
  return `${contributionAgentCreatedAtIndexRootDir(zoneId, agentId, sessionId)}/${bucket}`;
}

/** Path to a created-at contribution index marker for an agent. */
export function contributionAgentCreatedAtIndexPath(
  zoneId: string,
  agentId: string,
  createdAt: string,
  cid: string,
  sessionId?: string,
): string {
  return `${contributionAgentCreatedAtIndexBucketDir(
    zoneId,
    agentId,
    createdAtBucket(createdAt),
    sessionId,
  )}/${createdAtEntryName(createdAt, cid)}`;
}

/** Path to a relation index entry (from source pointing to target). */
export function relationIndexPath(
  zoneId: string,
  targetCid: string,
  sourceCid: string,
  sessionId?: string,
): string {
  return `${zoneDataBase(zoneId, sessionId)}/indexes/relations/${encodeSegment(targetCid)}/${encodeSegment(sourceCid)}.json`;
}

/** Directory containing all relations pointing to a target. */
export function relationIndexDir(zoneId: string, targetCid: string, sessionId?: string): string {
  return `${zoneDataBase(zoneId, sessionId)}/indexes/relations/${encodeSegment(targetCid)}`;
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

/** Path to a bounty content-hash dedup index marker. */
export function bountyContentHashIndexPath(zoneId: string, contentHash: string): string {
  return `/zones/${encodeSegment(zoneId)}/indexes/bounties/content-hash/${encodeSegment(contentHash)}`;
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

// ---------------------------------------------------------------------------
// Workflow paths
// ---------------------------------------------------------------------------

/** Path to a durable workflow state JSON file. */
export function workflowPath(zoneId: string, workflowId: string): string {
  return `/zones/${encodeSegment(zoneId)}/workflows/${encodeSegment(workflowId)}.json`;
}

/** Directory containing durable workflow state files. */
export function workflowsDir(zoneId: string): string {
  return `/zones/${encodeSegment(zoneId)}/workflows`;
}
