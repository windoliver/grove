/**
 * Per-agent log buffer — composes RingBuffer + IncrementalLogReader.
 *
 * Owns the full trace history for one agent role in one session.
 * Subscribers are notified at most once per 16ms frame (batched flush)
 * to avoid flooding React with re-renders when multiple agents produce
 * output simultaneously.
 *
 * Role and sessionId are stored on the buffer instance, not on each LogLine,
 * to save ~30% memory at 10K lines per agent.
 */

import { stripAnsi } from "../../shared/format.js";
import { isLogLineKept } from "../hooks/use-agent-monitor.js";
import { IncrementalLogReader } from "./incremental-log-reader.js";
import { RingBuffer } from "./ring-buffer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Classification of a trace line. */
export type LogLineType = "output" | "tool" | "ipc" | "turn";

/** A single trace line — minimal structure for memory efficiency. */
export interface LogLine {
  /** Epoch milliseconds. */
  readonly ts: number;
  /** The text content (ANSI-stripped). */
  readonly line: string;
  /** Classification of this line. */
  readonly type: LogLineType;
  /** Whether this line was loaded from history (dimmed in UI). */
  readonly historical?: boolean;
}

/** Subscriber callback — called when the buffer has new lines. */
export type LogBufferListener = () => void;

// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------

/** Classify a raw log line by its content pattern. */
export function classifyLine(line: string): LogLineType {
  const trimmed = line.trim();
  if (trimmed.startsWith("[tool]") || trimmed.startsWith("[Tool]")) return "tool";
  if (trimmed.startsWith("[IPC") || trimmed.startsWith("[ipc")) return "ipc";
  if (trimmed.startsWith("[done]") || trimmed.startsWith("[end_turn]")) return "turn";
  return "output";
}

// ---------------------------------------------------------------------------
// AgentLogBuffer
// ---------------------------------------------------------------------------

const DEFAULT_CAPACITY = 10_000;
const FLUSH_INTERVAL_MS = 16; // ~60fps

export class AgentLogBuffer {
  readonly role: string;
  readonly sessionId: string;

  private readonly buffer: RingBuffer<LogLine>;
  private readonly listeners = new Set<LogBufferListener>();
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private reader: IncrementalLogReader | null = null;
  private readerPath: string | null = null;
  /**
   * Seeked byte offsets per file path — set by recordSeekPosition() at new-session
   * start. When pollLogFile() creates a new reader for a path that was previously
   * seeked, the reader is restored to that offset so old data is not re-read.
   *
   * This is the key fix for "old session data mixed in" bugs: even if pollLogFile()
   * switches to a different log file than was seeked (e.g. coder-0 → coder-1),
   * the per-path positions ensure each file starts from the right place.
   */
  private readonly seekedPositions = new Map<string, number>();

  constructor(role: string, sessionId: string, capacity: number = DEFAULT_CAPACITY) {
    this.role = role;
    this.sessionId = sessionId;
    this.buffer = new RingBuffer<LogLine>(capacity);
  }

  // ─── Public API ───

  /** Number of lines in the buffer. */
  get size(): number {
    return this.buffer.size;
  }

  /** Whether auto-scroll should be active (no pinned position). */
  get isEmpty(): boolean {
    return this.buffer.isEmpty;
  }

  /** Get a line by logical index (0 = oldest). */
  get(index: number): LogLine | undefined {
    return this.buffer.get(index);
  }

  /** Get a viewport slice of lines. */
  slice(start: number, end: number): LogLine[] {
    return this.buffer.slice(start, end);
  }

  /** Get all lines as an array (for serialization). */
  toArray(): LogLine[] {
    return this.buffer.toArray();
  }

  // ─── Ingestion ───

  /** Push a single parsed line into the buffer. */
  push(line: LogLine): void {
    this.buffer.push(line);
    this.scheduleBatchedFlush();
  }

  /** Push raw text lines (from log files or IPC), filtering and classifying them. */
  pushRawLines(lines: readonly string[], historical = false): void {
    const now = Date.now();
    for (const raw of lines) {
      if (!isLogLineKept(raw)) continue;
      const stripped = stripAnsi(raw);
      if (stripped.trim().length === 0) continue;
      this.buffer.push({
        ts: now,
        line: stripped,
        type: classifyLine(stripped),
        ...(historical ? { historical: true } : {}),
      });
    }
    if (lines.length > 0) {
      this.scheduleBatchedFlush();
    }
  }

  /**
   * Poll the log file for new lines via IncrementalLogReader.
   * Call this on a timer (e.g., every 500ms when TracePane is visible).
   *
   * When the file path changes (e.g. acpx recycles coder-0.log → coder-1.log),
   * a new reader is created. If this file was previously seeked via
   * recordSeekPosition(), the reader is restored to that offset so old data
   * from before the current session is not re-read.
   */
  async pollLogFile(logFilePath: string): Promise<void> {
    if (!this.reader || this.readerPath !== logFilePath) {
      this.reader = new IncrementalLogReader(logFilePath);
      this.readerPath = logFilePath;
      // Restore seeked position for this file (set at session start).
      // If the file is brand-new (not in seekedPositions), offset stays 0
      // which is correct — a new file only contains the current session's data.
      const seekedPos = this.seekedPositions.get(logFilePath);
      if (seekedPos !== undefined) {
        this.reader.restoreOffset(seekedPos);
      }
    }
    const newLines = await this.reader.readNew();
    if (newLines.length > 0) {
      this.pushRawLines(newLines);
    }
  }

  /**
   * Record the current end-of-file position for a log file path.
   * Called synchronously at new-session start (using statSync) for ALL
   * existing log files for this role. This ensures pollLogFile() starts
   * reading from the right position regardless of which file acpx writes to.
   */
  recordSeekPosition(filePath: string, offset: number): void {
    this.seekedPositions.set(filePath, offset);
    // If a reader already exists for this path, restore it too
    if (this.readerPath === filePath && this.reader) {
      this.reader.restoreOffset(offset);
    }
  }

  /**
   * Clear the display buffer for a new session start.
   * Does NOT affect seekedPositions — those are preserved to guide
   * subsequent pollLogFile() calls.
   */
  clearForNewSession(): void {
    this.buffer.clear();
    this.notifyListeners();
  }

  // ─── Subscription ───

  /** Subscribe to buffer changes. Listener is called at most once per 16ms. */
  subscribe(listener: LogBufferListener): void {
    this.listeners.add(listener);
  }

  /** Unsubscribe from buffer changes. */
  unsubscribe(listener: LogBufferListener): void {
    this.listeners.delete(listener);
  }

  // ─── Lifecycle ───

  /** Clear all lines and reset the reader. */
  clear(): void {
    this.buffer.clear();
    this.reader?.reset();
    this.notifyListeners();
  }

  /**
   * Seek the reader to the current end of the log file so only new lines
   * (written after this call) are returned. Call when starting a fresh session
   * to avoid replaying historical log data.
   */
  async seekToEnd(logFilePath: string): Promise<void> {
    if (!this.reader || this.readerPath !== logFilePath) {
      this.reader = new IncrementalLogReader(logFilePath);
      this.readerPath = logFilePath;
    }
    await this.reader.seekToEnd();
    this.buffer.clear();
    this.notifyListeners();
  }

  /** Stop the flush timer. Call when disposing the buffer. */
  dispose(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.listeners.clear();
  }

  // ─── Serialization (for JSONL persistence) ───

  /** Serialize all lines to JSONL format with role and sessionId on each line. */
  toJsonl(): string {
    const lines = this.buffer.toArray();
    return lines
      .map((l) =>
        JSON.stringify({
          sessionId: this.sessionId,
          role: this.role,
          timestamp: new Date(l.ts).toISOString(),
          line: l.line,
          type: l.type,
        }),
      )
      .join("\n");
  }

  /** Load lines from JSONL content (for resume). All lines marked as historical. */
  loadFromJsonl(content: string): void {
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    for (const raw of lines) {
      try {
        const parsed = JSON.parse(raw) as {
          timestamp?: string;
          line?: string;
          type?: string;
        };
        if (parsed.line) {
          this.buffer.push({
            ts: parsed.timestamp ? new Date(parsed.timestamp).getTime() : 0,
            line: parsed.line,
            type: (parsed.type as LogLineType) ?? "output",
            historical: true,
          });
        }
      } catch {
        // Skip malformed lines
      }
    }
    this.scheduleBatchedFlush();
  }

  // ─── Internal ───

  private scheduleBatchedFlush(): void {
    this.dirty = true;
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        if (this.dirty) {
          this.dirty = false;
          this.notifyListeners();
        }
      }, FLUSH_INTERVAL_MS);
    }
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
