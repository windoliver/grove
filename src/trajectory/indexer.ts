import { readFile } from "node:fs/promises";
import { parseAcpxLine } from "./parsers/acpx.js";
import { parseClaudeStreamJsonLine } from "./parsers/claude-stream-json.js";
import { parseCodexLine } from "./parsers/codex.js";
import { parseSubprocessLine } from "./parsers/subprocess.js";
import type {
  ParsedTrajectoryEvent,
  TrajectoryEvent,
  TrajectoryRuntimeInput,
  TranscriptIndex,
} from "./types.js";
import { TrajectoryRuntime } from "./types.js";

export interface BuildTranscriptIndexOptions {
  readonly transcriptPath: string;
  readonly runtime: TrajectoryRuntimeInput;
}

export function detectRuntimeFromLines(lines: readonly string[]): TrajectoryRuntime {
  const records = parsedRecords(lines);

  if (records.some(hasCodexAcpMetadata)) {
    return TrajectoryRuntime.Codex;
  }

  if (records.some(isClaudeStreamJsonRecord)) {
    return TrajectoryRuntime.ClaudeStreamJson;
  }

  if (records.some(isGenericAcpRecord)) {
    return TrajectoryRuntime.Acpx;
  }

  if (records.some(isCodexRecord)) {
    return TrajectoryRuntime.Codex;
  }

  return TrajectoryRuntime.Subprocess;
}

export async function buildTranscriptIndex(
  options: BuildTranscriptIndexOptions,
): Promise<TranscriptIndex> {
  const content = await readFile(options.transcriptPath, "utf8");
  const lines = transcriptLines(content);
  const runtime =
    options.runtime === "auto"
      ? detectRuntimeFromLines(lines.filter((line) => line.length > 0).slice(0, 20))
      : options.runtime;

  const events: TrajectoryEvent[] = [];
  const warnings: string[] = [];
  let seq = 1;

  lines.forEach((line, index) => {
    const result = parseLine(line, options.transcriptPath, index + 1, runtime);
    warnings.push(...result.warnings);

    for (const event of result.events) {
      events.push({ ...event, seq });
      seq += 1;
    }
  });

  return {
    runtime,
    transcriptPath: options.transcriptPath,
    events,
    warnings,
    bySeq: indexBySeq(events),
    bySpanId: indexByStringField(events, "spanId"),
    childrenByParentSpanId: indexByStringField(events, "parentSpanId"),
  };
}

function parseLine(
  line: string,
  path: string,
  lineNumber: number,
  runtime: TrajectoryRuntime,
): { readonly events: readonly ParsedTrajectoryEvent[]; readonly warnings: readonly string[] } {
  switch (runtime) {
    case TrajectoryRuntime.Acpx:
      return parseAcpxLine(line, path, lineNumber, runtime);
    case TrajectoryRuntime.Codex:
      return parseCodexLine(line, path, lineNumber);
    case TrajectoryRuntime.ClaudeStreamJson:
      return parseClaudeStreamJsonLine(line, path, lineNumber);
    case TrajectoryRuntime.Subprocess:
    case TrajectoryRuntime.Unknown:
      return parseSubprocessLine(line, path, lineNumber);
  }
}

function transcriptLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  while (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function parsedRecords(lines: readonly string[]): readonly Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        records.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Runtime detection skips plain subprocess output and malformed JSONL.
    }
  }

  return records;
}

function hasCodexAcpMetadata(value: unknown): boolean {
  if (typeof value === "string") {
    return value.includes("codex-acp");
  }

  if (Array.isArray(value)) {
    return value.some(hasCodexAcpMetadata);
  }

  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(hasCodexAcpMetadata);
  }

  return false;
}

function isClaudeStreamJsonRecord(record: Readonly<Record<string, unknown>>): boolean {
  if (record.parent_tool_use_id !== undefined || record.tool_use_id !== undefined) {
    return true;
  }

  return record.type === "assistant" && Array.isArray(record.message);
}

function isGenericAcpRecord(record: Readonly<Record<string, unknown>>): boolean {
  return record.method === "session/update" || record.method === "session/new";
}

function isCodexRecord(record: Readonly<Record<string, unknown>>): boolean {
  return record.type === "codex_event" || record.source === "codex";
}

function indexBySeq(events: readonly TrajectoryEvent[]): ReadonlyMap<number, TrajectoryEvent> {
  const bySeq = new Map<number, TrajectoryEvent>();
  for (const event of events) {
    bySeq.set(event.seq, event);
  }
  return bySeq;
}

function indexByStringField(
  events: readonly TrajectoryEvent[],
  field: "spanId" | "parentSpanId",
): ReadonlyMap<string, readonly TrajectoryEvent[]> {
  const index = new Map<string, TrajectoryEvent[]>();

  for (const event of events) {
    const key = event[field];
    if (key === undefined) {
      continue;
    }

    const existing = index.get(key);
    if (existing === undefined) {
      index.set(key, [event]);
    } else {
      existing.push(event);
    }
  }

  return index;
}
