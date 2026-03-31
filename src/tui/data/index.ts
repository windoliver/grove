/**
 * Data layer for agent trace management.
 *
 * Exports the three core classes:
 * - RingBuffer: fixed-capacity circular buffer
 * - IncrementalLogReader: tail-f style log file reader
 * - AgentLogBuffer: per-agent log buffer composing the above
 */

export {
  AgentLogBuffer,
  classifyLine,
  type LogBufferListener,
  type LogLine,
  type LogLineType,
} from "./agent-log-buffer.js";
export { IncrementalLogReader } from "./incremental-log-reader.js";
export { RingBuffer } from "./ring-buffer.js";
export { loadTraceHistory, saveTraceHistory } from "./trace-persistence.js";
