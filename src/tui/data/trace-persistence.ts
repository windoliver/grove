/**
 * Trace persistence — saves/loads agent trace history as JSONL files.
 *
 * Storage path: .grove/agent-logs/{sessionId}/{role}.jsonl
 *
 * On session end: saveAll() writes each buffer's trace history.
 * On resume: loadAll() restores historical lines into new buffers.
 *
 * Local-first: no Nexus dependency. Optional VFS upload deferred.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentLogBuffer } from "./agent-log-buffer.js";

/**
 * Save all agent trace buffers to JSONL files.
 *
 * Creates directory .grove/agent-logs/{sessionId}/ and writes one
 * .jsonl file per role. Overwrites existing files.
 */
export async function saveTraceHistory(
  groveDir: string,
  sessionId: string,
  buffers: ReadonlyMap<string, AgentLogBuffer>,
): Promise<void> {
  if (buffers.size === 0) return;

  const sessionDir = join(groveDir, "agent-logs", sessionId);
  try {
    await mkdir(sessionDir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  const writes: Promise<void>[] = [];
  for (const [role, buffer] of buffers) {
    if (buffer.size === 0) continue;
    const filePath = join(sessionDir, `${role}.jsonl`);
    const content = buffer.toJsonl();
    writes.push(writeFile(filePath, `${content}\n`, "utf-8"));
  }
  await Promise.all(writes);
}

/**
 * Load trace history for a session into AgentLogBuffer instances.
 *
 * Reads all .jsonl files from .grove/agent-logs/{sessionId}/ and
 * creates a buffer per role with historical lines. If no files exist,
 * returns an empty map.
 */
export async function loadTraceHistory(
  groveDir: string,
  sessionId: string,
): Promise<Map<string, AgentLogBuffer>> {
  const sessionDir = join(groveDir, "agent-logs", sessionId);
  const buffers = new Map<string, AgentLogBuffer>();

  if (!existsSync(sessionDir)) return buffers;

  try {
    const entries = await readdir(sessionDir);
    const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));

    for (const file of jsonlFiles) {
      const role = file.replace(/\.jsonl$/, "");
      const filePath = join(sessionDir, file);
      try {
        const content = await readFile(filePath, "utf-8");
        const buffer = new AgentLogBuffer(role, sessionId);
        buffer.loadFromJsonl(content);
        buffers.set(role, buffer);
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory read failed — return empty
  }

  return buffers;
}
