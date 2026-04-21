/**
 * Repo reference + URL normalization.
 *
 * Pure module: no I/O. Consumers use `normalizeUrl` to canonicalize a
 * repo reference, then `deriveCachePath` to get a cache-entry path
 * segment. Path-safety is enforced here — callers must not trust
 * `path.join` alone to sanitize a remote-controlled URL.
 */

export type RepoRef =
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "url"; readonly url: string; readonly ref?: string };

export interface NormalizedRepo {
  readonly host: string;
  readonly path: string;
}

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;
const SCP_LIKE_RE = /^([^@\s]+@)?([^:/\s]+):(.+)$/;

export function normalizeUrl(raw: string): NormalizedRepo {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error("empty repo reference");

  const scpMatch =
    !SCHEME_RE.test(trimmed) && !trimmed.startsWith("/") ? trimmed.match(SCP_LIKE_RE) : null;

  let host: string;
  let rawPath: string;

  if (scpMatch) {
    host = scpMatch[2]!;
    rawPath = scpMatch[3]!;
  } else if (SCHEME_RE.test(trimmed)) {
    // Reject empty-authority URLs (e.g. "https:///foo/bar") before URL() normalizes them.
    if (/^[a-z][a-z0-9+.-]*:\/\/\//i.test(trimmed) && !/^file:/i.test(trimmed)) {
      throw new Error(`normalized host is empty: ${trimmed}`);
    }
    const u = new URL(trimmed);
    if (u.protocol === "file:") {
      host = "local";
      // Extract raw pathname from the URL string to catch traversal before URL() normalizes it.
      rawPath = trimmed.replace(/^file:\/\//i, "").replace(/^\//, "");
    } else {
      host = u.hostname;
      // Extract raw path from the URL string to catch traversal before URL() normalizes it.
      // Strip scheme://[user@]host from front, then strip leading slash.
      const afterHost = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
      rawPath = afterHost.replace(/^\//, "");
    }
  } else if (trimmed.startsWith("/")) {
    host = "local";
    rawPath = trimmed.slice(1);
  } else {
    throw new Error(`repo reference must be absolute or a known URL scheme: ${trimmed}`);
  }

  if (host === "") throw new Error(`normalized host is empty: ${raw}`);

  // Validate raw path BEFORE cleaning, so traversal segments (e.g. `..`) that
  // URL() would silently normalize away are still caught.
  const rawCleaned = rawPath.replace(/\.git$/, "").replace(/\/+$/, "");
  validatePathSegments(rawCleaned);

  const cleaned = rawCleaned;

  if (cleaned === "") throw new Error(`normalized path is empty: ${raw}`);

  return { host: host.toLowerCase(), path: cleaned };
}

function validatePathSegments(path: string): void {
  for (const seg of path.split("/")) {
    if (seg === "") throw new Error(`invalid path (empty segment): ${path}`);
    if (seg === ".." || seg === ".") {
      throw new Error(`invalid path (traversal '${seg}'): ${path}`);
    }
    if (seg.startsWith(".")) {
      throw new Error(`invalid path (leading dot in segment '${seg}'): ${path}`);
    }
  }
}

export function deriveCachePath(n: NormalizedRepo): string {
  return `${n.host}/${n.path}.git`;
}
