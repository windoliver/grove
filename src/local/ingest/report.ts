/**
 * Markdown report ingestion into CAS.
 *
 * Reads a markdown file and stores it as a single artifact
 * in the content-addressed store.
 */

import type { ContentStore } from "../../core/cas.js";

/**
 * Ingest a markdown report file into CAS.
 *
 * Reads the file at the given path and stores it as a single artifact
 * named "report". The media type is set to "text/markdown".
 *
 * @param cas - Content-addressable store to write into.
 * @param path - Path to the markdown report file.
 * @returns Map of artifact name → content hash.
 */
export async function ingestReport(
  cas: ContentStore,
  path: string,
): Promise<Record<string, string>> {
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) {
    throw new Error(`Report file not found: ${path}`);
  }

  const data = new Uint8Array(await file.arrayBuffer());
  const hash = await cas.put(data, { mediaType: "text/markdown" });

  return { report: hash };
}
