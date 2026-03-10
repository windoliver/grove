/**
 * Git diff ingestion into CAS.
 *
 * Runs `git diff` against a given ref and stores the diff output
 * as a single artifact in the content-addressed store.
 */

import type { ContentStore } from "../../core/cas.js";
import { spawnOrThrow } from "../../core/subprocess.js";

/**
 * Ingest a git diff as a single artifact into CAS.
 *
 * Runs `git diff <ref>` in the given working directory (defaults to cwd).
 * The diff output is stored as a single artifact named "diff".
 *
 * @param cas - Content-addressable store to write into.
 * @param ref - Git ref to diff against (e.g., "HEAD~1", "main", a commit hash).
 * @param cwd - Working directory for the git command. Defaults to process.cwd().
 * @returns Map of artifact name → content hash.
 * @throws If `git diff` fails (e.g., invalid ref, not a git repo).
 */
export async function ingestGitDiff(
  cas: ContentStore,
  ref: string,
  cwd?: string,
): Promise<Record<string, string>> {
  // Reject refs that start with "-" to prevent git option injection.
  // A value like "--output=/tmp/out.diff" would be parsed as a git flag,
  // not a ref, allowing command behavior modification or file writes.
  if (ref.startsWith("-")) {
    throw new Error(`Invalid git ref: '${ref}' (must not start with '-')`);
  }

  const stdout = await spawnOrThrow(
    ["git", "diff", ref, "--"],
    { cwd: cwd ?? process.cwd() },
    "git diff",
  );

  if (stdout.length === 0) {
    return {};
  }

  const data = new TextEncoder().encode(stdout);
  const hash = await cas.put(data, { mediaType: "text/x-diff" });

  return { diff: hash };
}
