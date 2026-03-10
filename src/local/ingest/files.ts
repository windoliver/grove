/**
 * File/directory ingestion into CAS.
 *
 * Walks the given paths (files or directories) and stores each file
 * in the content-addressed store. Returns a map of relative path → content hash.
 */

import { readdir, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

import type { ContentStore } from "../../core/cas.js";

/**
 * Normalize a relative path to use forward slashes regardless of OS.
 * On Windows, `path.relative()` returns backslash-separated paths,
 * but artifact names must use forward slashes (per spec) so they can
 * be materialized on any platform.
 */
function toPortableName(name: string): string {
  return sep === "\\" ? name.replaceAll("\\", "/") : name;
}

/**
 * Ingest files and directories into CAS.
 *
 * For each path:
 * - If it's a file, store it directly. The artifact name is the basename.
 * - If it's a directory, recursively walk and store all files.
 *   Artifact names are relative paths from the directory root.
 *
 * @param cas - Content-addressable store to write into.
 * @param paths - File or directory paths to ingest.
 * @returns Map of artifact name → content hash.
 */
export async function ingestFiles(
  cas: ContentStore,
  paths: readonly string[],
): Promise<Record<string, string>> {
  const artifacts: Record<string, string> = {};

  for (const p of paths) {
    const info = await stat(p);
    if (info.isDirectory()) {
      await walkDirectory(cas, p, p, artifacts);
    } else if (info.isFile()) {
      const name = basename(p);
      if (name in artifacts) {
        throw new Error(
          `Artifact name collision: '${name}' already exists. Use directories to avoid name conflicts.`,
        );
      }
      const hash = await cas.putFile(p);
      artifacts[name] = hash;
    }
  }

  return artifacts;
}

async function walkDirectory(
  cas: ContentStore,
  rootDir: string,
  currentDir: string,
  artifacts: Record<string, string>,
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);

    if (entry.isDirectory()) {
      // Skip .grove and .git directories
      if (entry.name === ".grove" || entry.name === ".git") {
        continue;
      }
      await walkDirectory(cas, rootDir, fullPath, artifacts);
    } else if (entry.isFile()) {
      const name = toPortableName(relative(rootDir, fullPath));
      if (name in artifacts) {
        throw new Error(
          `Artifact name collision: '${name}' already exists. Use distinct directory structures to avoid name conflicts.`,
        );
      }
      const hash = await cas.putFile(fullPath);
      artifacts[name] = hash;
    }
  }
}
