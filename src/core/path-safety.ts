/**
 * Path containment and artifact name sanitization utilities.
 *
 * These are security-critical functions that prevent path traversal attacks
 * when agents work inside isolated workspaces. Every path written to or
 * read from a workspace MUST pass through these checks.
 *
 * Strategy: resolve symlinks via realpath, then verify the resolved path
 * starts with the boundary root. For non-existent paths, walk up to the
 * nearest existing ancestor and resolve that.
 */

import { realpath } from "node:fs/promises";
import { isAbsolute, normalize, resolve } from "node:path";

/** Characters allowed in sanitized artifact names: [A-Za-z0-9._-] */
const SAFE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Pattern for path components that indicate traversal. */
const TRAVERSAL_COMPONENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/**
 * Resolve the real (symlink-free) path for an existing path,
 * or walk up to the nearest existing ancestor for paths that
 * don't exist yet.
 *
 * This prevents symlink-based escapes where a symlink inside
 * the workspace points to a directory outside the boundary.
 */
async function safeRealpath(targetPath: string): Promise<string> {
  try {
    return await realpath(targetPath);
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      // Path doesn't exist — resolve the nearest existing ancestor
      return resolveFromExistingAncestor(targetPath);
    }
    throw err;
  }
}

/**
 * For a non-existent path, find the nearest existing ancestor directory,
 * resolve its real path, then append the remaining path segments.
 *
 * Example: if `/workspace/foo/bar/baz.txt` doesn't exist but
 * `/workspace/foo` does, resolve `/workspace/foo` and append `bar/baz.txt`.
 */
async function resolveFromExistingAncestor(targetPath: string): Promise<string> {
  const normalized = normalize(targetPath);
  const segments = normalized.split("/").filter(Boolean);

  // Walk from root, adding segments until we find the longest existing prefix
  let existingPrefix = "/";
  let remainingStart = 0;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === undefined) break;
    const candidate = resolve(existingPrefix, segment);
    try {
      existingPrefix = await realpath(candidate);
      remainingStart = i + 1;
    } catch {
      // This segment doesn't exist — everything from here is the remainder
      break;
    }
  }

  // Append remaining (non-existent) segments to the resolved ancestor
  const remaining = segments.slice(remainingStart);
  return resolve(existingPrefix, ...remaining);
}

/**
 * Assert that a target path is contained within a boundary root.
 *
 * Resolves symlinks and normalizes the path before checking containment.
 * Throws a descriptive error if the path escapes the boundary.
 *
 * @param targetPath - The path to validate (absolute or relative to boundary).
 * @param boundaryRoot - The root directory that must contain the target.
 * @throws Error if the path escapes the boundary.
 */
export async function assertWithinBoundary(
  targetPath: string,
  boundaryRoot: string,
): Promise<string> {
  // Resolve boundary root first (it must exist)
  const resolvedBoundary = await realpath(boundaryRoot);

  // Resolve the target path relative to the boundary
  const absoluteTarget = isAbsolute(targetPath)
    ? targetPath
    : resolve(resolvedBoundary, targetPath);

  // Resolve symlinks (or ancestor for non-existent paths)
  const resolvedTarget = await safeRealpath(absoluteTarget);

  // Containment check: resolved path must start with boundary + separator
  // (or equal the boundary exactly)
  if (resolvedTarget !== resolvedBoundary && !resolvedTarget.startsWith(`${resolvedBoundary}/`)) {
    throw new PathContainmentError(targetPath, resolvedBoundary, resolvedTarget);
  }

  return resolvedTarget;
}

/**
 * Validate and sanitize an artifact name for use as a filename.
 *
 * Rejects names that could cause path traversal or filesystem issues:
 * - Path separators (/ or \)
 * - Parent directory references (..)
 * - Absolute paths
 * - Null bytes
 * - Empty or whitespace-only names
 * - Names that are just "." or ".."
 *
 * @returns The validated name (unchanged — this is a gate, not a transform).
 * @throws Error if the name is invalid.
 */
export function validateArtifactName(name: string): string {
  if (name.length === 0) {
    throw new ArtifactNameError(name, "artifact name must not be empty");
  }

  if (name.trim().length === 0) {
    throw new ArtifactNameError(name, "artifact name must not be whitespace-only");
  }

  // Null byte injection
  if (name.includes("\0")) {
    throw new ArtifactNameError(name, "artifact name must not contain null bytes");
  }

  // Reject characters that are problematic on various filesystems:
  // / \ : * ? " < > | (Windows reserved + Unix path separators)
  const UNSAFE_CHARS = /[/\\:*?"<>|]/;
  if (UNSAFE_CHARS.test(name)) {
    throw new ArtifactNameError(
      name,
      'artifact name must not contain path separators or reserved characters (/ \\ : * ? " < > |)',
    );
  }

  // Parent directory reference
  if (name === ".." || name === ".") {
    throw new ArtifactNameError(name, "artifact name must not be a relative directory reference");
  }

  // Absolute path injection (unlikely after separator check, but defense in depth)
  if (isAbsolute(name)) {
    throw new ArtifactNameError(name, "artifact name must not be an absolute path");
  }

  return name;
}

/**
 * Sanitize a CID for use as a directory name.
 *
 * CIDs have the format `blake3:<64-hex>`. The colon is problematic
 * on some filesystems (Windows). This extracts just the hex portion,
 * which is always a valid directory name.
 *
 * @throws Error if the CID doesn't match the expected format.
 */
export function sanitizeCidForPath(cid: string): string {
  const prefix = "blake3:";
  if (!cid.startsWith(prefix)) {
    throw new Error(`Cannot sanitize CID: expected 'blake3:' prefix, got '${cid}'`);
  }
  const hex = cid.slice(prefix.length);
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error("Cannot sanitize CID: hex portion must be 64 lowercase hex characters");
  }
  return hex;
}

/**
 * Validate that a workspace key (used as directory name) contains
 * only safe characters: [A-Za-z0-9._-]
 *
 * @throws Error if the key contains unsafe characters.
 */
export function validateWorkspaceKey(key: string): string {
  if (key.length === 0) {
    throw new Error("Workspace key must not be empty");
  }
  if (!SAFE_NAME_PATTERN.test(key)) {
    throw new Error(
      `Workspace key '${key}' contains unsafe characters: only [A-Za-z0-9._-] allowed`,
    );
  }
  return key;
}

/**
 * Check if a raw path string contains obvious traversal patterns.
 *
 * This is a fast pre-check before the more expensive realpath-based
 * validation. It catches simple `../` attacks but should NOT be used
 * as the sole defense — always follow up with assertWithinBoundary().
 */
export function containsTraversal(path: string): boolean {
  return TRAVERSAL_COMPONENT.test(path) || isAbsolute(path);
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Error thrown when a path escapes its containment boundary. */
export class PathContainmentError extends Error {
  readonly inputPath: string;
  readonly boundary: string;
  readonly resolvedPath: string;

  constructor(inputPath: string, boundary: string, resolvedPath: string) {
    super(
      `Path containment violation: '${inputPath}' resolves to '${resolvedPath}' ` +
        `which is outside boundary '${boundary}'`,
    );
    this.name = "PathContainmentError";
    this.inputPath = inputPath;
    this.boundary = boundary;
    this.resolvedPath = resolvedPath;
  }
}

/** Error thrown when an artifact name is invalid. */
export class ArtifactNameError extends Error {
  readonly artifactName: string;

  constructor(artifactName: string, reason: string) {
    super(`Invalid artifact name '${artifactName}': ${reason}`);
    this.name = "ArtifactNameError";
    this.artifactName = artifactName;
  }
}
