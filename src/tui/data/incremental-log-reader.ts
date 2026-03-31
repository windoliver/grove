/**
 * Incremental log file reader — tail -f pattern.
 *
 * Tracks byte offset per file. On each readNew(), reads only new bytes
 * since the last read. Handles file truncation (log rotation) by detecting
 * when file size < offset and resetting.
 *
 * Buffers partial lines at the boundary — only returns complete lines
 * (terminated by \n).
 */

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export class IncrementalLogReader {
  private byteOffset = 0;
  private partialLine = "";
  private lastIno: number | null = null;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Read new complete lines since the last call.
   * Returns empty array if no new data or file doesn't exist.
   *
   * Detects file replacement (inode change) and truncation (size < offset)
   * and resets automatically.
   */
  async readNew(): Promise<string[]> {
    try {
      const fileStat = await stat(this.filePath);
      const fileSize = fileStat.size;

      // Detect file replacement (new inode = new file, e.g. log rotation or recreate)
      if (this.lastIno !== null && fileStat.ino !== this.lastIno) {
        this.byteOffset = 0;
        this.partialLine = "";
      }
      this.lastIno = fileStat.ino;

      if (fileSize === this.byteOffset) {
        // No new data
        return [];
      }

      if (fileSize < this.byteOffset) {
        // File was truncated in place — reset and read from start
        this.byteOffset = 0;
        this.partialLine = "";
      }

      // Read only new bytes
      const file = Bun.file(this.filePath);
      const newBytes = file.slice(this.byteOffset, fileSize);
      const text = await newBytes.text();

      this.byteOffset = fileSize;

      // Split into lines, handling partial line from previous read
      const raw = this.partialLine + text;
      const segments = raw.split("\n");

      // Last segment is either empty (line ended with \n) or a partial line
      this.partialLine = segments.pop() ?? "";

      // Filter out empty strings from split
      return segments.filter((s) => s.length > 0);
    } catch {
      // File doesn't exist or read error — return empty
      return [];
    }
  }

  /** Reset the reader to the beginning of the file. */
  reset(): void {
    this.byteOffset = 0;
    this.partialLine = "";
  }

  /**
   * Read all lines from multiple log files for a role, sorted by mtime (oldest first).
   *
   * Files are matched by pattern: `{role}*.log` (e.g., coder-0.log, coder-1.log).
   * Returns all complete lines concatenated in chronological order.
   */
  static async readAllSorted(logDir: string, role: string): Promise<string[]> {
    try {
      if (!existsSync(logDir)) return [];

      const entries = await readdir(logDir);
      const roleFiles = entries.filter(
        (f) =>
          f.endsWith(".log") &&
          f.startsWith(role) &&
          (f === `${role}.log` || f.charAt(role.length) === "-"),
      );

      if (roleFiles.length === 0) return [];

      // Get mtime for each file and sort oldest first
      const fileStats = await Promise.all(
        roleFiles.map(async (f) => {
          const filePath = join(logDir, f);
          const s = await stat(filePath);
          return { path: filePath, mtime: s.mtimeMs };
        }),
      );
      fileStats.sort((a, b) => a.mtime - b.mtime);

      // Read and concatenate
      const allLines: string[] = [];
      for (const { path } of fileStats) {
        const content = await readFile(path, "utf-8");
        const lines = content.split("\n").filter((l) => l.length > 0);
        allLines.push(...lines);
      }
      return allLines;
    } catch {
      return [];
    }
  }
}
