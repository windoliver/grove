/**
 * Git working tree ingestion into CAS.
 *
 * Uses `git ls-files` to enumerate tracked files and stores each one
 * in the content-addressed store. Respects .gitignore.
 */

import { join } from "node:path";

import type { ContentStore } from "../../core/cas.js";

/**
 * Ingest the current git working tree into CAS.
 *
 * Uses `git ls-files` to get tracked, non-ignored files. Each file is
 * stored in the CAS individually. Artifact names are relative paths
 * from the repo root.
 *
 * @param cas - Content-addressable store to write into.
 * @param cwd - Working directory for the git command. Defaults to process.cwd().
 * @returns Map of artifact name → content hash.
 * @throws If `git ls-files` fails (e.g., not a git repo).
 */
export async function ingestGitTree(
  cas: ContentStore,
  cwd?: string,
): Promise<Record<string, string>> {
  const workDir = cwd ?? process.cwd();

  const proc = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: workDir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`git ls-files failed (exit ${exitCode}): ${stderr.trim()}`);
  }

  const files = stdout
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
    // Skip .grove directory contents
    .filter((f) => !f.startsWith(".grove/") && !f.startsWith(".grove\\"));

  const artifacts: Record<string, string> = {};

  for (const file of files) {
    const fullPath = join(workDir, file);
    const hash = await cas.putFile(fullPath);
    artifacts[file] = hash;
  }

  return artifacts;
}
