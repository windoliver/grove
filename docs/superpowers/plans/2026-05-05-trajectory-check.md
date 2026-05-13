# Trajectory Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `grove check-trajectory` and `grove_check_trajectory` for local transcript files, with runtime normalization, deterministic YAML rule checks, and sequence cross-reference reports.

**Architecture:** Add a focused `src/trajectory/` package for transcript indexing, runtime parsers, YAML specs, rule evaluation, and reports. Expose it through a shared operation in `src/core/operations/check-trajectory.ts`, then wire CLI and MCP surfaces around that operation.

**Tech Stack:** Bun 1.3.x, TypeScript strict mode, `bun:test`, existing `yaml` dependency, existing MCP SDK, existing operation-result and CLI patterns.

**Spec:** `docs/superpowers/specs/2026-05-05-trajectory-check-design.md`

**Issue:** [#339](https://github.com/windoliver/grove/issues/339)

---

## File Map

**Create:**
- `src/trajectory/types.ts` - normalized event, parser, spec, rule, and report contracts.
- `src/trajectory/types.test.ts` - event constants and sequence marker tests.
- `src/trajectory/match.ts` - dotted-field lookup, glob alternation, event matching.
- `src/trajectory/match.test.ts` - matcher behavior tests.
- `src/trajectory/indexer.ts` - JSONL loading, runtime selection, sequence assignment, indexes.
- `src/trajectory/indexer.test.ts` - sequence, lookup, malformed-line, and auto-detect tests.
- `src/trajectory/parsers/acpx.ts` - ACP JSON-RPC NDJSON parser.
- `src/trajectory/parsers/codex.ts` - Codex ACP and native transcript parser.
- `src/trajectory/parsers/claude-stream-json.ts` - Claude Code stream-json parser with parent span mapping.
- `src/trajectory/parsers/subprocess.ts` - line-oriented subprocess parser.
- `src/trajectory/parsers/*.test.ts` - parser fixture tests.
- `src/trajectory/spec-loader.ts` - YAML spec loading and validation.
- `src/trajectory/spec-loader.test.ts` - valid spec, invalid spec, duplicate rule tests.
- `src/trajectory/rules.ts` - deterministic rule engine.
- `src/trajectory/rules.test.ts` - tests for all five rule kinds.
- `src/trajectory/report.ts` - markdown, JSON, and annotated-log formatting.
- `src/trajectory/report.test.ts` - formatter tests.
- `src/core/operations/check-trajectory.ts` - operation wrapper shared by CLI and MCP.
- `src/core/operations/check-trajectory.test.ts` - operation file I/O and validation tests.
- `src/cli/commands/check-trajectory.ts` - CLI parser and runner.
- `src/cli/commands/check-trajectory.test.ts` - CLI parser and temp-file command tests.
- `src/mcp/tools/trajectory.ts` - MCP tool registration.
- `src/mcp/tools/trajectory.test.ts` - MCP registration and result tests.
- `tests/fixtures/trajectory/claude-stream-json.jsonl` - Claude delegation fixture.
- `tests/fixtures/trajectory/codex-transcript.jsonl` - Codex native fixture.
- `tests/fixtures/trajectory/subprocess.log` - subprocess fixture.
- `spec/trajectory/common.yaml` - default deterministic check spec.

**Modify:**
- `src/core/operations/index.ts` - export check-trajectory operation and types.
- `src/core/operations/parity-matrix.test.ts` - add shared operation coverage.
- `src/cli/main.ts` - register `check-trajectory` command and help text.
- `src/mcp/server.ts` - register trajectory MCP tools.
- `docs/parity-matrix.md` - add check-trajectory row.

---

## Task 1: Core Types And Sequence Markers

**Files:**
- Create: `src/trajectory/types.ts`
- Test: `src/trajectory/types.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/trajectory/types.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { formatSeq, isTrajectoryEventType, TrajectoryEventType } from "./types.js";

describe("TrajectoryEventType", () => {
  test("includes deterministic issue #339 event types and timeline-compatible event families", () => {
    expect(TrajectoryEventType.ToolCall).toBe("TOOL_CALL");
    expect(TrajectoryEventType.PermissionDenied).toBe("PERMISSION_DENIED");
    expect(TrajectoryEventType.WorkBlockStarted).toBe("WORK_BLOCK_STARTED");
    expect(TrajectoryEventType.TaskScheduled).toBe("TASK_SCHEDULED");
    expect(TrajectoryEventType.HealthRecovered).toBe("HEALTH_RECOVERED");
    expect(TrajectoryEventType.Raw).toBe("RAW");
  });

  test("validates event type values", () => {
    expect(isTrajectoryEventType("TOOL_CALL")).toBe(true);
    expect(isTrajectoryEventType("tool_call")).toBe(false);
    expect(isTrajectoryEventType("NOT_REAL")).toBe(false);
  });
});

describe("formatSeq", () => {
  test("formats sequence markers with four digits until values exceed four digits", () => {
    expect(formatSeq(1)).toBe("[seq:0001]");
    expect(formatSeq(42)).toBe("[seq:0042]");
    expect(formatSeq(12_345)).toBe("[seq:12345]");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/trajectory/types.test.ts
```

Expected: FAIL with `Cannot find module './types.js'`.

- [ ] **Step 3: Create the core contracts**

Create `src/trajectory/types.ts` with these exports:

```typescript
export const TrajectoryEventType = {
  AgentStart: "AGENT_START",
  ToolCall: "TOOL_CALL",
  ToolResult: "TOOL_RESULT",
  Delegation: "DELEGATION",
  DelegationReturn: "DELEGATION_RETURN",
  AssistantMessage: "ASSISTANT_MESSAGE",
  Compaction: "COMPACTION",
  PermissionDenied: "PERMISSION_DENIED",
  WorkBlockStarted: "WORK_BLOCK_STARTED",
  WorkBlockUpdated: "WORK_BLOCK_UPDATED",
  WorkBlockFinished: "WORK_BLOCK_FINISHED",
  TaskTriggered: "TASK_TRIGGERED",
  TaskAdmitted: "TASK_ADMITTED",
  TaskScheduled: "TASK_SCHEDULED",
  PermissionWait: "PERMISSION_WAIT",
  PermissionDecision: "PERMISSION_DECISION",
  HealthDegraded: "HEALTH_DEGRADED",
  HealthRecovered: "HEALTH_RECOVERED",
  ContributionChanged: "CONTRIBUTION_CHANGED",
  ArtifactChanged: "ARTIFACT_CHANGED",
  ReviewChanged: "REVIEW_CHANGED",
  AdoptionChanged: "ADOPTION_CHANGED",
  Raw: "RAW",
} as const;

export type TrajectoryEventType =
  (typeof TrajectoryEventType)[keyof typeof TrajectoryEventType];

export const TrajectoryRuntime = {
  Acpx: "acpx",
  Codex: "codex",
  ClaudeStreamJson: "claude-stream-json",
  Subprocess: "subprocess",
  Unknown: "unknown",
} as const;

export type TrajectoryRuntime = (typeof TrajectoryRuntime)[keyof typeof TrajectoryRuntime];
export type TrajectoryRuntimeInput = TrajectoryRuntime | "auto";
export type ReportFormat = "markdown" | "json";

export interface TrajectorySource {
  readonly path: string;
  readonly line: number;
}

export interface TrajectoryEvent {
  readonly seq: number;
  readonly type: TrajectoryEventType;
  readonly runtime: TrajectoryRuntime;
  readonly timestamp?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly role?: string | undefined;
  readonly spanId?: string | undefined;
  readonly parentSpanId?: string | undefined;
  readonly tool?: string | undefined;
  readonly status?: string | undefined;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly message?: string | undefined;
  readonly error?: string | undefined;
  readonly raw?: unknown;
  readonly source: TrajectorySource;
}

export type ParsedTrajectoryEvent = Omit<TrajectoryEvent, "seq">;

export interface TranscriptIndex {
  readonly runtime: TrajectoryRuntime;
  readonly transcriptPath: string;
  readonly events: readonly TrajectoryEvent[];
  readonly warnings: readonly string[];
  readonly bySeq: ReadonlyMap<number, TrajectoryEvent>;
  readonly bySpanId: ReadonlyMap<string, readonly TrajectoryEvent[]>;
  readonly childrenByParentSpanId: ReadonlyMap<string, readonly TrajectoryEvent[]>;
}

export interface EventMatcher {
  readonly event?: string | undefined;
  readonly tool?: string | undefined;
  readonly field_match?: Readonly<Record<string, string>> | undefined;
  readonly field_not_match?: Readonly<Record<string, string>> | undefined;
}

export interface RequiredMatcher extends EventMatcher {
  readonly match_field?: string | undefined;
}

export type RuleKind =
  | "precedes"
  | "allowed_tools"
  | "must_exist"
  | "must_not_exist"
  | "field_constraint";

export interface RuleSpec {
  readonly id: string;
  readonly kind: RuleKind;
  readonly match?: EventMatcher | undefined;
  readonly trigger?: EventMatcher | undefined;
  readonly required?: RequiredMatcher | undefined;
  readonly allowed?: readonly string[] | undefined;
  readonly field?: string | undefined;
  readonly equals?: unknown;
  readonly not_equals?: unknown;
  readonly match_value?: string | undefined;
  readonly not_match?: string | undefined;
  readonly exists?: boolean | undefined;
  readonly not_exists?: boolean | undefined;
}

export interface GoalSpec {
  readonly id: string;
  readonly criteria: string;
  readonly evidence: readonly string[];
}

export interface TrajectorySpec {
  readonly name: string;
  readonly sourcePaths: readonly string[];
  readonly rules: readonly RuleSpec[];
  readonly goals: readonly GoalSpec[];
}

export type CheckStatus = "pass" | "fail" | "deferred";

export interface RuleViolation {
  readonly ruleId: string;
  readonly message: string;
  readonly seq?: number | undefined;
  readonly seqRef?: string | undefined;
  readonly source?: TrajectorySource | undefined;
  readonly eventType?: TrajectoryEventType | undefined;
  readonly tool?: string | undefined;
  readonly status?: string | undefined;
  readonly spanId?: string | undefined;
  readonly messageSnippet?: string | undefined;
}

export interface RuleResult {
  readonly ruleId: string;
  readonly status: CheckStatus;
  readonly violations: readonly RuleViolation[];
}

export interface GoalResult {
  readonly goalId: string;
  readonly status: "deferred";
  readonly message: string;
}

export interface TrajectoryCheckReport {
  readonly name: string;
  readonly transcriptPath: string;
  readonly runtime: TrajectoryRuntime;
  readonly eventCount: number;
  readonly specPaths: readonly string[];
  readonly ruleResults: readonly RuleResult[];
  readonly goalResults: readonly GoalResult[];
  readonly parserWarnings: readonly string[];
  readonly summary: {
    readonly passed: number;
    readonly failed: number;
    readonly deferred: number;
  };
}

const EVENT_TYPES = new Set<string>(Object.values(TrajectoryEventType));

export function isTrajectoryEventType(value: string): value is TrajectoryEventType {
  return EVENT_TYPES.has(value);
}

export function formatSeq(seq: number): string {
  return `[seq:${seq.toString().padStart(4, "0")}]`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
bun test src/trajectory/types.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trajectory/types.ts src/trajectory/types.test.ts
git commit -m "feat: add trajectory core types"
```

---

## Task 2: Event Matching Utilities

**Files:**
- Create: `src/trajectory/match.ts`
- Test: `src/trajectory/match.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/trajectory/match.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { fieldValue, matchesEvent, normalizeEventTypeName, patternMatches } from "./match.js";
import { TrajectoryEventType, type TrajectoryEvent } from "./types.js";

const baseEvent: TrajectoryEvent = {
  seq: 7,
  type: TrajectoryEventType.ToolCall,
  runtime: "codex",
  tool: "apply_patch",
  input: { file_path: "src/app.ts", patch: "--- a/src/app.ts" },
  raw: { nested: { value: "alpha" } },
  source: { path: "transcript.jsonl", line: 3 },
};

describe("normalizeEventTypeName", () => {
  test("accepts canonical and lowercase event aliases", () => {
    expect(normalizeEventTypeName("TOOL_CALL")).toBe("TOOL_CALL");
    expect(normalizeEventTypeName("tool_call")).toBe("TOOL_CALL");
    expect(normalizeEventTypeName("permission_denied")).toBe("PERMISSION_DENIED");
    expect(normalizeEventTypeName("not_real")).toBeUndefined();
  });
});

describe("fieldValue", () => {
  test("reads normalized fields and raw payload fields", () => {
    expect(fieldValue(baseEvent, "input.file_path")).toBe("src/app.ts");
    expect(fieldValue(baseEvent, "raw.nested.value")).toBe("alpha");
    expect(fieldValue(baseEvent, "missing.value")).toBeUndefined();
  });
});

describe("patternMatches", () => {
  test("supports glob wildcards and pipe alternation", () => {
    expect(patternMatches("apply_patch", "apply_patch|edit_file")).toBe(true);
    expect(patternMatches("--- a/src/app.ts", "--- a/*")).toBe(true);
    expect(patternMatches("read_file", "apply_patch|edit_file")).toBe(false);
  });
});

describe("matchesEvent", () => {
  test("matches by event, tool, field_match, and field_not_match", () => {
    expect(
      matchesEvent(baseEvent, {
        event: "tool_call",
        tool: "apply_patch|edit_file",
        field_match: { "input.file_path": "src/*" },
        field_not_match: { "input.patch": "--- /dev/null*" },
      }),
    ).toBe(true);

    expect(
      matchesEvent(baseEvent, {
        event: "permission_denied",
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/trajectory/match.test.ts
```

Expected: FAIL with `Cannot find module './match.js'`.

- [ ] **Step 3: Implement match helpers**

Create `src/trajectory/match.ts`:

```typescript
import { isDeepStrictEqual } from "node:util";
import type { EventMatcher, TrajectoryEvent, TrajectoryEventType } from "./types.js";
import { isTrajectoryEventType } from "./types.js";

export function normalizeEventTypeName(value: string): TrajectoryEventType | undefined {
  const upper = value.trim().toUpperCase();
  return isTrajectoryEventType(upper) ? upper : undefined;
}

export function fieldValue(source: unknown, path: string): unknown {
  if (path.length === 0) return undefined;
  const parts = path.split(".");
  let current = source;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function patternMatches(value: unknown, pattern: string): boolean {
  if (value === undefined || value === null) return false;
  const text = String(value);
  return pattern.split("|").some((part) => globPartMatches(text, part));
}

export function valuesEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

export function matchesEvent(event: TrajectoryEvent, matcher: EventMatcher): boolean {
  if (matcher.event !== undefined) {
    const normalized = normalizeEventTypeName(matcher.event);
    if (normalized === undefined || event.type !== normalized) return false;
  }

  if (matcher.tool !== undefined && !patternMatches(event.tool, matcher.tool)) {
    return false;
  }

  for (const [path, pattern] of Object.entries(matcher.field_match ?? {})) {
    if (!patternMatches(fieldValue(event, path), pattern)) return false;
  }

  for (const [path, pattern] of Object.entries(matcher.field_not_match ?? {})) {
    if (patternMatches(fieldValue(event, path), pattern)) return false;
  }

  return true;
}

function globPartMatches(value: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${escaped}$`).test(value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
bun test src/trajectory/match.test.ts src/trajectory/types.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trajectory/match.ts src/trajectory/match.test.ts
git commit -m "feat: add trajectory event matching"
```

---

## Task 3: Subprocess Parser

**Files:**
- Create: `src/trajectory/parsers/subprocess.ts`
- Test: `src/trajectory/parsers/subprocess.test.ts`
- Create: `tests/fixtures/trajectory/subprocess.log`

- [ ] **Step 1: Write fixture and failing test**

Create `tests/fixtures/trajectory/subprocess.log`:

```text
{"event":"AGENT_START","spanId":"proc-1","message":"started","timestamp":"2026-05-05T00:00:00Z"}
plain stdout line
{"stream":"stderr","message":"warning: denied","event":"PERMISSION_DENIED"}
```

Create `src/trajectory/parsers/subprocess.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseSubprocessLine } from "./subprocess.js";

describe("parseSubprocessLine", () => {
  test("maps structured events and keeps plain text as RAW", async () => {
    const text = await readFile("tests/fixtures/trajectory/subprocess.log", "utf8");
    const lines = text.trimEnd().split("\n");

    const first = parseSubprocessLine(lines[0] ?? "", "subprocess.log", 1);
    const second = parseSubprocessLine(lines[1] ?? "", "subprocess.log", 2);
    const third = parseSubprocessLine(lines[2] ?? "", "subprocess.log", 3);

    expect(first.events[0]?.type).toBe("AGENT_START");
    expect(first.events[0]?.spanId).toBe("proc-1");
    expect(second.events[0]?.type).toBe("RAW");
    expect(second.events[0]?.message).toBe("plain stdout line");
    expect(second.warnings[0]).toContain("line 2");
    expect(third.events[0]?.type).toBe("PERMISSION_DENIED");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/trajectory/parsers/subprocess.test.ts
```

Expected: FAIL with `Cannot find module './subprocess.js'`.

- [ ] **Step 3: Implement subprocess parser**

Create `src/trajectory/parsers/subprocess.ts`:

```typescript
import { normalizeEventTypeName } from "../match.js";
import type { ParsedTrajectoryEvent } from "../types.js";
import { TrajectoryEventType, TrajectoryRuntime } from "../types.js";

export function parseSubprocessLine(
  line: string,
  path: string,
  lineNumber: number,
): { readonly events: readonly ParsedTrajectoryEvent[]; readonly warnings: readonly string[] } {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return raw(line, path, lineNumber, "non-object JSONL record");
    }
    const record = parsed as Record<string, unknown>;
    const type = inferType(record);
    return {
      events: [
        {
          type,
          runtime: TrajectoryRuntime.Subprocess,
          timestamp: stringField(record, "timestamp"),
          spanId: stringField(record, "spanId") ?? stringField(record, "span_id"),
          parentSpanId: stringField(record, "parentSpanId") ?? stringField(record, "parent_span_id"),
          tool: stringField(record, "tool") ?? stringField(record, "tool_name"),
          status: stringField(record, "status"),
          input: record.input,
          output: record.output,
          message: stringField(record, "message") ?? stringField(record, "text"),
          error: stringField(record, "error"),
          raw: record,
          source: { path, line: lineNumber },
        },
      ],
      warnings: [],
    };
  } catch {
    return raw(line, path, lineNumber, `line ${lineNumber}: non-JSON subprocess output kept as RAW`);
  }
}

function inferType(record: Record<string, unknown>): TrajectoryEventType {
  const eventName = stringField(record, "event") ?? stringField(record, "type") ?? stringField(record, "kind");
  if (eventName !== undefined) {
    const normalized = normalizeEventTypeName(eventName);
    if (normalized !== undefined) return normalized;
  }
  if (record.stream === "stdout" || record.stream === "stderr") return TrajectoryEventType.AssistantMessage;
  if (record.command !== undefined || record.pid !== undefined) return TrajectoryEventType.AgentStart;
  return TrajectoryEventType.Raw;
}

function raw(
  line: string,
  path: string,
  lineNumber: number,
  warning: string,
): { readonly events: readonly ParsedTrajectoryEvent[]; readonly warnings: readonly string[] } {
  return {
    events: [
      {
        type: TrajectoryEventType.Raw,
        runtime: TrajectoryRuntime.Subprocess,
        message: line,
        error: warning,
        raw: line,
        source: { path, line: lineNumber },
      },
    ],
    warnings: [warning],
  };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
bun test src/trajectory/parsers/subprocess.test.ts src/trajectory/match.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trajectory/parsers/subprocess.ts src/trajectory/parsers/subprocess.test.ts tests/fixtures/trajectory/subprocess.log
git commit -m "feat: parse subprocess trajectory logs"
```

---

## Task 4: Transcript Indexer And Runtime Detection

**Files:**
- Create: `src/trajectory/indexer.ts`
- Test: `src/trajectory/indexer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/trajectory/indexer.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTranscriptIndex, detectRuntimeFromLines } from "./indexer.js";
import { TrajectoryEventType } from "./types.js";

async function tempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "trajectory-index-"));
  const path = join(dir, name);
  await writeFile(path, content, "utf8");
  return path;
}

describe("detectRuntimeFromLines", () => {
  test("detects codex ACP metadata before generic acpx", () => {
    const lines = [
      '{"jsonrpc":"2.0","id":0,"result":{"agentInfo":{"name":"codex-acp"}}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk"}}}',
    ];
    expect(detectRuntimeFromLines(lines)).toBe("codex");
  });

  test("detects claude stream-json parent tool use shape", () => {
    const lines = ['{"type":"tool_result","tool_use_id":"child","parent_tool_use_id":"parent"}'];
    expect(detectRuntimeFromLines(lines)).toBe("claude-stream-json");
  });

  test("falls back to subprocess", () => {
    expect(detectRuntimeFromLines(["plain output"])).toBe("subprocess");
  });
});

describe("buildTranscriptIndex", () => {
  test("assigns sequence numbers, source lines, and span indexes", async () => {
    const transcript = await tempFile(
      "events.jsonl",
      [
        '{"event":"AGENT_START","spanId":"session-1"}',
        '{"event":"TOOL_CALL","tool":"apply_patch","spanId":"tool-1","parentSpanId":"session-1"}',
      ].join("\n"),
    );

    const index = await buildTranscriptIndex({
      transcriptPath: transcript,
      runtime: "subprocess",
    });

    expect(index.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(index.events[1]?.source.line).toBe(2);
    expect(index.bySeq.get(2)?.tool).toBe("apply_patch");
    expect(index.bySpanId.get("tool-1")?.[0]?.type).toBe(TrajectoryEventType.ToolCall);
    expect(index.childrenByParentSpanId.get("session-1")?.[0]?.spanId).toBe("tool-1");
  });

  test("keeps malformed JSONL as RAW with a parser warning", async () => {
    const transcript = await tempFile("bad.log", "not-json\n");
    const index = await buildTranscriptIndex({ transcriptPath: transcript, runtime: "subprocess" });

    expect(index.events).toHaveLength(1);
    expect(index.events[0]?.type).toBe(TrajectoryEventType.Raw);
    expect(index.warnings[0]).toContain("line 1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/trajectory/indexer.test.ts
```

Expected: FAIL with `Cannot find module './indexer.js'`.

- [ ] **Step 3: Implement the indexer with subprocess routing**

Create `src/trajectory/indexer.ts`:

```typescript
import { readFile } from "node:fs/promises";
import { parseSubprocessLine } from "./parsers/subprocess.js";
import type {
  ParsedTrajectoryEvent,
  TrajectoryEvent,
  TrajectoryRuntime,
  TrajectoryRuntimeInput,
  TranscriptIndex,
} from "./types.js";
import { TrajectoryRuntime } from "./types.js";

export interface BuildTranscriptIndexOptions {
  readonly transcriptPath: string;
  readonly runtime: TrajectoryRuntimeInput;
}

export function detectRuntimeFromLines(lines: readonly string[]): TrajectoryRuntime {
  for (const line of lines) {
    const parsed = parseJson(line);
    if (parsed === undefined) continue;
    const record = parsed as Record<string, unknown>;
    if (JSON.stringify(record).includes("codex-acp")) return TrajectoryRuntime.Codex;
    if (
      "parent_tool_use_id" in record ||
      "tool_use_id" in record ||
      (record.type === "assistant" && Array.isArray(record.message))
    ) {
      return TrajectoryRuntime.ClaudeStreamJson;
    }
    if (record.method === "session/update" || record.method === "session/new") {
      return TrajectoryRuntime.Acpx;
    }
    if (record.type === "codex_event" || record.source === "codex") return TrajectoryRuntime.Codex;
  }
  return TrajectoryRuntime.Subprocess;
}

export async function buildTranscriptIndex(
  options: BuildTranscriptIndexOptions,
): Promise<TranscriptIndex> {
  const text = await readFile(options.transcriptPath, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  const runtime =
    options.runtime === "auto" ? detectRuntimeFromLines(lines.slice(0, 20)) : options.runtime;
  const warnings: string[] = [];
  const parsedEvents: ParsedTrajectoryEvent[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const line = lines[i] ?? "";
    const parsed = parseLine(runtime, line, options.transcriptPath, lineNumber);
    parsedEvents.push(...parsed.events);
    warnings.push(...parsed.warnings);
  }

  const events = parsedEvents.map((event, index) => ({ ...event, seq: index + 1 }));
  return createTranscriptIndex(runtime, options.transcriptPath, events, warnings);
}

function parseLine(
  runtime: TrajectoryRuntime,
  line: string,
  path: string,
  lineNumber: number,
): { readonly events: readonly ParsedTrajectoryEvent[]; readonly warnings: readonly string[] } {
  switch (runtime) {
    case TrajectoryRuntime.Acpx:
    case TrajectoryRuntime.Codex:
    case TrajectoryRuntime.ClaudeStreamJson:
    case TrajectoryRuntime.Subprocess:
    case TrajectoryRuntime.Unknown:
      return parseSubprocessLine(line, path, lineNumber);
  }
}

function createTranscriptIndex(
  runtime: TrajectoryRuntime,
  transcriptPath: string,
  events: readonly TrajectoryEvent[],
  warnings: readonly string[],
): TranscriptIndex {
  const bySeq = new Map<number, TrajectoryEvent>();
  const bySpanId = new Map<string, TrajectoryEvent[]>();
  const childrenByParentSpanId = new Map<string, TrajectoryEvent[]>();

  for (const event of events) {
    bySeq.set(event.seq, event);
    if (event.spanId !== undefined) {
      const bucket = bySpanId.get(event.spanId) ?? [];
      bucket.push(event);
      bySpanId.set(event.spanId, bucket);
    }
    if (event.parentSpanId !== undefined) {
      const bucket = childrenByParentSpanId.get(event.parentSpanId) ?? [];
      bucket.push(event);
      childrenByParentSpanId.set(event.parentSpanId, bucket);
    }
  }

  return {
    runtime,
    transcriptPath,
    events,
    warnings,
    bySeq,
    bySpanId,
    childrenByParentSpanId,
  };
}

function parseJson(line: string): unknown | undefined {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
bun test src/trajectory/indexer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trajectory/indexer.ts src/trajectory/indexer.test.ts
git commit -m "feat: build trajectory transcript index"
```

---

## Task 5: ACP, Codex, And Claude Parsers

**Files:**
- Create: `src/trajectory/parsers/acpx.ts`
- Create: `src/trajectory/parsers/codex.ts`
- Create: `src/trajectory/parsers/claude-stream-json.ts`
- Test: `src/trajectory/parsers/acpx.test.ts`
- Test: `src/trajectory/parsers/codex.test.ts`
- Test: `src/trajectory/parsers/claude-stream-json.test.ts`
- Create: `tests/fixtures/trajectory/claude-stream-json.jsonl`
- Create: `tests/fixtures/trajectory/codex-transcript.jsonl`

- [ ] **Step 1: Write fixtures**

Create `tests/fixtures/trajectory/claude-stream-json.jsonl`:

```jsonl
{"type":"assistant","message":[{"type":"text","text":"I will inspect the repo."}],"timestamp":"2026-05-05T00:00:00Z"}
{"type":"tool_use","id":"tool-parent","name":"Task","input":{"description":"review"}}
{"type":"tool_use","id":"tool-child","parent_tool_use_id":"tool-parent","name":"Read","input":{"file_path":"src/index.ts"}}
{"type":"tool_result","tool_use_id":"tool-child","parent_tool_use_id":"tool-parent","content":"done"}
{"type":"tool_result","tool_use_id":"tool-parent","content":"subagent returned"}
```

Create `tests/fixtures/trajectory/codex-transcript.jsonl`:

```jsonl
{"type":"agent_start","session_id":"sess-1","agent_id":"codex-1","timestamp":"2026-05-05T00:00:00Z"}
{"type":"tool_call","call_id":"call-1","tool_name":"apply_patch","input":{"file_path":"src/app.ts"}}
{"type":"tool_result","call_id":"call-1","output":"ok","status":"completed"}
{"type":"assistant_message","message":"patched"}
```

- [ ] **Step 2: Write failing parser tests**

Create `src/trajectory/parsers/acpx.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseAcpxLine } from "./acpx.js";

describe("parseAcpxLine", () => {
  test("maps ACP fixture session updates to trajectory events", async () => {
    const text = await readFile("tests/fixtures/acp/claude-tool-call.ndjson", "utf8");
    const all = text
      .trimEnd()
      .split("\n")
      .flatMap((line, index) => parseAcpxLine(line, "claude-tool-call.ndjson", index + 1, "acpx").events);

    expect(all.some((event) => event.type === "AGENT_START")).toBe(true);
    expect(all.some((event) => event.type === "ASSISTANT_MESSAGE")).toBe(true);
    expect(all.some((event) => event.type === "TOOL_CALL")).toBe(true);
  });
});
```

Create `src/trajectory/parsers/codex.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseCodexLine } from "./codex.js";

describe("parseCodexLine", () => {
  test("maps native codex transcript records", async () => {
    const text = await readFile("tests/fixtures/trajectory/codex-transcript.jsonl", "utf8");
    const all = text
      .trimEnd()
      .split("\n")
      .flatMap((line, index) => parseCodexLine(line, "codex-transcript.jsonl", index + 1).events);

    expect(all.map((event) => event.type)).toEqual([
      "AGENT_START",
      "TOOL_CALL",
      "TOOL_RESULT",
      "ASSISTANT_MESSAGE",
    ]);
    expect(all[1]?.tool).toBe("apply_patch");
    expect(all[2]?.spanId).toBe("call-1");
  });
});
```

Create `src/trajectory/parsers/claude-stream-json.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseClaudeStreamJsonLine } from "./claude-stream-json.js";

describe("parseClaudeStreamJsonLine", () => {
  test("maps parent_tool_use_id into delegation spans", async () => {
    const text = await readFile("tests/fixtures/trajectory/claude-stream-json.jsonl", "utf8");
    const all = text
      .trimEnd()
      .split("\n")
      .flatMap((line, index) =>
        parseClaudeStreamJsonLine(line, "claude-stream-json.jsonl", index + 1).events,
      );

    expect(all[0]?.type).toBe("ASSISTANT_MESSAGE");
    expect(all[1]?.type).toBe("DELEGATION");
    expect(all[2]?.type).toBe("TOOL_CALL");
    expect(all[2]?.parentSpanId).toBe("tool-parent");
    expect(all[3]?.type).toBe("TOOL_RESULT");
    expect(all[4]?.type).toBe("DELEGATION_RETURN");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
bun test src/trajectory/parsers/acpx.test.ts src/trajectory/parsers/codex.test.ts src/trajectory/parsers/claude-stream-json.test.ts
```

Expected: FAIL with missing parser modules.

- [ ] **Step 4: Implement parser helpers**

Implement `src/trajectory/parsers/acpx.ts`:

```typescript
import type { ParsedTrajectoryEvent, TrajectoryRuntime } from "../types.js";
import { TrajectoryEventType } from "../types.js";

export function parseAcpxLine(
  line: string,
  path: string,
  lineNumber: number,
  runtime: TrajectoryRuntime,
): { readonly events: readonly ParsedTrajectoryEvent[]; readonly warnings: readonly string[] } {
  const parsed = parseJsonObject(line);
  if (parsed === undefined) return raw(line, path, lineNumber, runtime, "invalid JSON");

  if (parsed.method === "session/new") {
    return { events: [], warnings: [] };
  }

  if (isObject(parsed.result) && typeof parsed.result.sessionId === "string") {
    return {
      events: [
        {
          type: TrajectoryEventType.AgentStart,
          runtime,
          sessionId: parsed.result.sessionId,
          raw: parsed,
          source: { path, line: lineNumber },
        },
      ],
      warnings: [],
    };
  }

  if (parsed.method === "session/update" && isObject(parsed.params)) {
    const sessionId = stringField(parsed.params, "sessionId");
    const update = parsed.params.update;
    if (!isObject(update)) return raw(parsed, path, lineNumber, runtime, "session/update missing update");
    const sessionUpdate = stringField(update, "sessionUpdate");
    if (sessionUpdate === "agent_message_chunk" || sessionUpdate === "user_message_chunk") {
      return event(TrajectoryEventType.AssistantMessage, runtime, path, lineNumber, parsed, {
        sessionId,
        message: readContentText(update.content),
      });
    }
    if (sessionUpdate === "tool_call") {
      return event(TrajectoryEventType.ToolCall, runtime, path, lineNumber, parsed, {
        sessionId,
        spanId: stringField(update, "toolCallId"),
        tool: readCanonicalTool(update) ?? stringField(update, "title"),
        status: stringField(update, "status"),
        input: update.rawInput,
      });
    }
    if (sessionUpdate === "tool_call_update") {
      return event(TrajectoryEventType.ToolResult, runtime, path, lineNumber, parsed, {
        sessionId,
        spanId: stringField(update, "toolCallId"),
        tool: readCanonicalTool(update) ?? stringField(update, "title"),
        status: stringField(update, "status"),
        input: update.rawInput,
        output: update.rawOutput,
      });
    }
    if (sessionUpdate === "permission_request") {
      return event(TrajectoryEventType.PermissionWait, runtime, path, lineNumber, parsed, {
        sessionId,
        spanId: stringField(update, "id") ?? stringField(update, "toolCallId"),
        tool: stringField(update, "tool"),
        input: update.input,
      });
    }
    return raw(parsed, path, lineNumber, runtime, `unmapped ACP update ${sessionUpdate ?? "unknown"}`);
  }

  if (isObject(parsed.error)) {
    return event(TrajectoryEventType.PermissionDenied, runtime, path, lineNumber, parsed, {
      error: stringField(parsed.error, "message"),
    });
  }

  return { events: [], warnings: [] };
}

function event(
  type: TrajectoryEventType,
  runtime: TrajectoryRuntime,
  path: string,
  lineNumber: number,
  raw: unknown,
  fields: Partial<ParsedTrajectoryEvent>,
): { readonly events: readonly ParsedTrajectoryEvent[]; readonly warnings: readonly string[] } {
  return {
    events: [{ type, runtime, raw, source: { path, line: lineNumber }, ...fields }],
    warnings: [],
  };
}

function raw(
  rawValue: unknown,
  path: string,
  lineNumber: number,
  runtime: TrajectoryRuntime,
  warning: string,
): { readonly events: readonly ParsedTrajectoryEvent[]; readonly warnings: readonly string[] } {
  return {
    events: [
      {
        type: TrajectoryEventType.Raw,
        runtime,
        raw: rawValue,
        message: typeof rawValue === "string" ? rawValue : undefined,
        error: warning,
        source: { path, line: lineNumber },
      },
    ],
    warnings: [`line ${lineNumber}: ${warning}`],
  };
}

function parseJsonObject(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readContentText(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const text = value.text;
  return typeof text === "string" ? text : undefined;
}

function readCanonicalTool(update: Record<string, unknown>): string | undefined {
  const meta = update._meta;
  if (!isObject(meta)) return undefined;
  const claudeCode = meta.claudeCode;
  if (!isObject(claudeCode)) return undefined;
  return stringField(claudeCode, "toolName");
}
```

Implement `src/trajectory/parsers/codex.ts`:

```typescript
import { parseAcpxLine } from "./acpx.js";
import { normalizeEventTypeName } from "../match.js";
import type { ParsedTrajectoryEvent } from "../types.js";
import { TrajectoryEventType, TrajectoryRuntime } from "../types.js";

export function parseCodexLine(
  line: string,
  path: string,
  lineNumber: number,
): { readonly events: readonly ParsedTrajectoryEvent[]; readonly warnings: readonly string[] } {
  if (line.includes('"jsonrpc"') || line.includes('"session/update"')) {
    return parseAcpxLine(line, path, lineNumber, TrajectoryRuntime.Codex);
  }

  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isObject(parsed)) return raw(line, path, lineNumber, "non-object Codex record");
    const type = inferCodexType(parsed);
    return {
      events: [
        {
          type,
          runtime: TrajectoryRuntime.Codex,
          timestamp: stringField(parsed, "timestamp"),
          sessionId: stringField(parsed, "session_id") ?? stringField(parsed, "sessionId"),
          agentId: stringField(parsed, "agent_id") ?? stringField(parsed, "agentId"),
          spanId: stringField(parsed, "call_id") ?? stringField(parsed, "id"),
          parentSpanId: stringField(parsed, "parent_call_id") ?? stringField(parsed, "parentSpanId"),
          tool: stringField(parsed, "tool_name") ?? stringField(parsed, "tool"),
          status: stringField(parsed, "status"),
          input: parsed.input,
          output: parsed.output,
          message: stringField(parsed, "message") ?? stringField(parsed, "text"),
          error: stringField(parsed, "error"),
          raw: parsed,
          source: { path, line: lineNumber },
        },
      ],
      warnings: [],
    };
  } catch {
    return raw(line, path, lineNumber, "invalid Codex JSONL record");
  }
}

function inferCodexType(record: Record<string, unknown>): TrajectoryEventType {
  const rawType = stringField(record, "type") ?? stringField(record, "event") ?? stringField(record, "kind");
  if (rawType !== undefined) {
    const normalized = normalizeEventTypeName(rawType);
    if (normalized !== undefined) return normalized;
    if (rawType === "agent_start") return TrajectoryEventType.AgentStart;
    if (rawType === "assistant_message") return TrajectoryEventType.AssistantMessage;
    if (rawType === "tool_call") return TrajectoryEventType.ToolCall;
    if (rawType === "tool_result") return TrajectoryEventType.ToolResult;
  }
  if (record.tool_name !== undefined || record.tool !== undefined) return TrajectoryEventType.ToolCall;
  return TrajectoryEventType.Raw;
}

function raw(
  line: string,
  path: string,
  lineNumber: number,
  warning: string,
): { readonly events: readonly ParsedTrajectoryEvent[]; readonly warnings: readonly string[] } {
  return {
    events: [
      {
        type: TrajectoryEventType.Raw,
        runtime: TrajectoryRuntime.Codex,
        message: line,
        error: warning,
        raw: line,
        source: { path, line: lineNumber },
      },
    ],
    warnings: [`line ${lineNumber}: ${warning}`],
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
```

Implement `src/trajectory/parsers/claude-stream-json.ts`:

```typescript
import type { ParsedTrajectoryEvent } from "../types.js";
import { TrajectoryEventType, TrajectoryRuntime } from "../types.js";

export function parseClaudeStreamJsonLine(
  line: string,
  path: string,
  lineNumber: number,
): { readonly events: readonly ParsedTrajectoryEvent[]; readonly warnings: readonly string[] } {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isObject(parsed)) return raw(line, path, lineNumber, "non-object Claude stream-json record");
    const type = inferClaudeType(parsed);
    return {
      events: [
        {
          type,
          runtime: TrajectoryRuntime.ClaudeStreamJson,
          timestamp: stringField(parsed, "timestamp"),
          spanId:
            stringField(parsed, "tool_use_id") ??
            stringField(parsed, "tool_call_id") ??
            stringField(parsed, "id"),
          parentSpanId: stringField(parsed, "parent_tool_use_id"),
          tool: stringField(parsed, "name") ?? stringField(parsed, "tool_name"),
          status: stringField(parsed, "status"),
          input: parsed.input,
          output: parsed.output ?? parsed.content,
          message: readMessage(parsed),
          error: stringField(parsed, "error"),
          raw: parsed,
          source: { path, line: lineNumber },
        },
      ],
      warnings: [],
    };
  } catch {
    return raw(line, path, lineNumber, "invalid Claude stream-json record");
  }
}

function inferClaudeType(record: Record<string, unknown>): TrajectoryEventType {
  const type = stringField(record, "type");
  const name = stringField(record, "name");
  if (type === "assistant") return TrajectoryEventType.AssistantMessage;
  if ((type === "tool_use" || type === "tool_call") && isDelegationTool(name)) {
    return TrajectoryEventType.Delegation;
  }
  if (type === "tool_use" || type === "tool_call") return TrajectoryEventType.ToolCall;
  if (type === "tool_result" && record.parent_tool_use_id === undefined) {
    return TrajectoryEventType.DelegationReturn;
  }
  if (type === "tool_result") return TrajectoryEventType.ToolResult;
  if (type === "permission_denied") return TrajectoryEventType.PermissionDenied;
  return TrajectoryEventType.Raw;
}

function readMessage(record: Record<string, unknown>): string | undefined {
  const direct = stringField(record, "message");
  if (direct !== undefined) return direct;
  const message = record.message;
  if (!Array.isArray(message)) return undefined;
  return message
    .map((part) => {
      if (!isObject(part)) return "";
      const text = part.text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

function isDelegationTool(name: string | undefined): boolean {
  if (name === undefined) return false;
  return name === "Task" || name.toLowerCase().includes("subagent");
}

function raw(
  line: string,
  path: string,
  lineNumber: number,
  warning: string,
): { readonly events: readonly ParsedTrajectoryEvent[]; readonly warnings: readonly string[] } {
  return {
    events: [
      {
        type: TrajectoryEventType.Raw,
        runtime: TrajectoryRuntime.ClaudeStreamJson,
        message: line,
        error: warning,
        raw: line,
        source: { path, line: lineNumber },
      },
    ],
    warnings: [`line ${lineNumber}: ${warning}`],
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
```

- [ ] **Step 5: Extend indexer routing for all runtime parsers**

Modify `src/trajectory/indexer.ts` imports:

```typescript
import { parseAcpxLine } from "./parsers/acpx.js";
import { parseClaudeStreamJsonLine } from "./parsers/claude-stream-json.js";
import { parseCodexLine } from "./parsers/codex.js";
```

Then replace the runtime switch in `parseLine`:

```typescript
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
```

- [ ] **Step 6: Run parser and indexer tests**

Run:

```bash
bun test src/trajectory/parsers/acpx.test.ts src/trajectory/parsers/codex.test.ts src/trajectory/parsers/claude-stream-json.test.ts src/trajectory/indexer.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/trajectory/parsers tests/fixtures/trajectory src/trajectory/indexer.ts src/trajectory/indexer.test.ts
git commit -m "feat: parse trajectory runtime transcripts"
```

---

## Task 6: YAML Spec Loader

**Files:**
- Create: `src/trajectory/spec-loader.ts`
- Test: `src/trajectory/spec-loader.test.ts`
- Create: `spec/trajectory/common.yaml`

- [ ] **Step 1: Write failing tests**

Create `src/trajectory/spec-loader.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTrajectorySpecs } from "./spec-loader.js";

async function writeSpec(name: string, text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "trajectory-spec-"));
  const path = join(dir, name);
  await writeFile(path, text, "utf8");
  return path;
}

describe("loadTrajectorySpecs", () => {
  test("loads and merges rules and deferred goals", async () => {
    const specPath = await writeSpec(
      "common.yaml",
      [
        "name: common",
        "rules:",
        "  - id: no-denials",
        "    kind: must_not_exist",
        "    match:",
        "      event: PERMISSION_DENIED",
        "goals:",
        "  - id: user-goal",
        "    criteria: User goal was met.",
        "    evidence: [assistant_message]",
      ].join("\n"),
    );

    const spec = await loadTrajectorySpecs([specPath]);
    expect(spec.name).toBe("common");
    expect(spec.rules[0]?.id).toBe("no-denials");
    expect(spec.goals[0]?.id).toBe("user-goal");
    expect(spec.sourcePaths).toEqual([specPath]);
  });

  test("rejects duplicate rule ids across files", async () => {
    const one = await writeSpec("one.yaml", "name: one\nrules:\n  - id: same\n    kind: must_exist\n");
    const two = await writeSpec("two.yaml", "name: two\nrules:\n  - id: same\n    kind: must_not_exist\n");

    await expect(loadTrajectorySpecs([one, two])).rejects.toThrow(/duplicate rule id: same/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/trajectory/spec-loader.test.ts
```

Expected: FAIL with `Cannot find module './spec-loader.js'`.

- [ ] **Step 3: Implement loader**

Create `src/trajectory/spec-loader.ts`:

```typescript
import { readFile } from "node:fs/promises";
import YAML from "yaml";
import type { GoalSpec, RuleKind, RuleSpec, TrajectorySpec } from "./types.js";

const RULE_KINDS = new Set<RuleKind>([
  "precedes",
  "allowed_tools",
  "must_exist",
  "must_not_exist",
  "field_constraint",
]);

export async function loadTrajectorySpecs(paths: readonly string[]): Promise<TrajectorySpec> {
  const rules: RuleSpec[] = [];
  const goals: GoalSpec[] = [];
  const seenRuleIds = new Set<string>();
  const names: string[] = [];

  for (const path of paths) {
    const text = await readFile(path, "utf8");
    const parsed = YAML.parse(text) as unknown;
    if (!isObject(parsed)) throw new Error(`Invalid trajectory spec ${path}: root must be an object`);
    const name = stringField(parsed, "name") ?? path;
    names.push(name);

    for (const rule of arrayField(parsed, "rules")) {
      const normalized = normalizeRule(rule, path);
      if (seenRuleIds.has(normalized.id)) {
        throw new Error(`duplicate rule id: ${normalized.id}`);
      }
      seenRuleIds.add(normalized.id);
      rules.push(normalized);
    }

    for (const goal of arrayField(parsed, "goals")) {
      goals.push(normalizeGoal(goal, path));
    }
  }

  return {
    name: names.join("+"),
    sourcePaths: [...paths],
    rules,
    goals,
  };
}

function normalizeRule(value: unknown, path: string): RuleSpec {
  if (!isObject(value)) throw new Error(`Invalid rule in ${path}: rule must be an object`);
  const id = stringField(value, "id");
  const kind = stringField(value, "kind");
  if (id === undefined) throw new Error(`Invalid rule in ${path}: id is required`);
  if (kind === undefined || !RULE_KINDS.has(kind as RuleKind)) {
    throw new Error(`Invalid rule ${id} in ${path}: unknown rule kind ${kind ?? ""}`);
  }
  return {
    id,
    kind: kind as RuleKind,
    ...(isObject(value.match) ? { match: value.match as RuleSpec["match"] } : {}),
    ...(isObject(value.trigger) ? { trigger: value.trigger as RuleSpec["trigger"] } : {}),
    ...(isObject(value.required) ? { required: value.required as RuleSpec["required"] } : {}),
    ...(Array.isArray(value.allowed) ? { allowed: value.allowed.map(String) } : {}),
    ...(typeof value.field === "string" ? { field: value.field } : {}),
    ...(Object.hasOwn(value, "equals") ? { equals: value.equals } : {}),
    ...(Object.hasOwn(value, "not_equals") ? { not_equals: value.not_equals } : {}),
    ...(typeof value.match_value === "string" ? { match_value: value.match_value } : {}),
    ...(typeof value.not_match === "string" ? { not_match: value.not_match } : {}),
    ...(typeof value.exists === "boolean" ? { exists: value.exists } : {}),
    ...(typeof value.not_exists === "boolean" ? { not_exists: value.not_exists } : {}),
  };
}

function normalizeGoal(value: unknown, path: string): GoalSpec {
  if (!isObject(value)) throw new Error(`Invalid goal in ${path}: goal must be an object`);
  const id = stringField(value, "id");
  const criteria = stringField(value, "criteria");
  if (id === undefined) throw new Error(`Invalid goal in ${path}: id is required`);
  if (criteria === undefined) throw new Error(`Invalid goal ${id} in ${path}: criteria is required`);
  return {
    id,
    criteria,
    evidence: arrayField(value, "evidence").map(String),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function arrayField(record: Record<string, unknown>, key: string): readonly unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}
```

- [ ] **Step 4: Add default spec**

Create `spec/trajectory/common.yaml`:

```yaml
name: common
rules:
  - id: no-permission-denials
    kind: must_not_exist
    match:
      event: PERMISSION_DENIED

  - id: has-agent-or-message
    kind: must_exist
    match:
      event: ASSISTANT_MESSAGE|AGENT_START

  - id: tool-calls-have-tool
    kind: field_constraint
    match:
      event: TOOL_CALL
    field: tool
    exists: true

  - id: tool-results-have-span
    kind: field_constraint
    match:
      event: TOOL_RESULT
    field: spanId
    exists: true

goals: []
```

- [ ] **Step 5: Run tests**

Run:

```bash
bun test src/trajectory/spec-loader.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/trajectory/spec-loader.ts src/trajectory/spec-loader.test.ts spec/trajectory/common.yaml
git commit -m "feat: load trajectory YAML specs"
```

---

## Task 7: Deterministic Rule Engine

**Files:**
- Create: `src/trajectory/rules.ts`
- Test: `src/trajectory/rules.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/trajectory/rules.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { evaluateRules } from "./rules.js";
import type { RuleSpec, TrajectoryEvent, TranscriptIndex } from "./types.js";

function event(seq: number, overrides: Partial<TrajectoryEvent>): TrajectoryEvent {
  return {
    seq,
    type: "TOOL_CALL",
    runtime: "codex",
    source: { path: "t.jsonl", line: seq },
    ...overrides,
  };
}

function index(events: readonly TrajectoryEvent[]): TranscriptIndex {
  return {
    runtime: "codex",
    transcriptPath: "t.jsonl",
    events,
    warnings: [],
    bySeq: new Map(events.map((item) => [item.seq, item])),
    bySpanId: new Map(),
    childrenByParentSpanId: new Map(),
  };
}

describe("evaluateRules", () => {
  test("must_not_exist reports matching event sequence refs", () => {
    const result = evaluateRules(index([event(1, { type: "PERMISSION_DENIED" })]), [
      { id: "no-denials", kind: "must_not_exist", match: { event: "PERMISSION_DENIED" } },
    ]);

    expect(result[0]?.status).toBe("fail");
    expect(result[0]?.violations[0]?.seqRef).toBe("[seq:0001]");
  });

  test("allowed_tools fails disallowed tool calls", () => {
    const result = evaluateRules(index([event(2, { tool: "rm" })]), [
      { id: "tools", kind: "allowed_tools", allowed: ["Read", "apply_patch"] },
    ]);

    expect(result[0]?.status).toBe("fail");
    expect(result[0]?.violations[0]?.message).toContain("rm");
  });

  test("field_constraint validates existence and glob matches", () => {
    const rules: RuleSpec[] = [
      { id: "has-tool", kind: "field_constraint", match: { event: "TOOL_CALL" }, field: "tool", exists: true },
      { id: "src-file", kind: "field_constraint", match: { event: "TOOL_CALL" }, field: "input.file_path", match_value: "src/*" },
    ];
    const result = evaluateRules(index([event(3, { tool: "Read", input: { file_path: "src/app.ts" } })]), rules);

    expect(result.every((item) => item.status === "pass")).toBe(true);
  });

  test("precedes requires prior matching evidence with same field", () => {
    const result = evaluateRules(
      index([
        event(1, { tool: "backup_file", input: { file_path: "src/app.ts" } }),
        event(2, { tool: "apply_patch", input: { file_path: "src/app.ts" } }),
        event(3, { tool: "apply_patch", input: { file_path: "src/other.ts" } }),
      ]),
      [
        {
          id: "backup-before-edit",
          kind: "precedes",
          trigger: { event: "TOOL_CALL", tool: "apply_patch" },
          required: { event: "TOOL_CALL", tool: "backup_file", match_field: "input.file_path" },
        },
      ],
    );

    expect(result[0]?.status).toBe("fail");
    expect(result[0]?.violations).toHaveLength(1);
    expect(result[0]?.violations[0]?.seq).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/trajectory/rules.test.ts
```

Expected: FAIL with `Cannot find module './rules.js'`.

- [ ] **Step 3: Implement rule engine**

Create `src/trajectory/rules.ts`:

```typescript
import { fieldValue, matchesEvent, patternMatches, valuesEqual } from "./match.js";
import type { RuleResult, RuleSpec, RuleViolation, TrajectoryEvent, TranscriptIndex } from "./types.js";
import { formatSeq, TrajectoryEventType } from "./types.js";

export function evaluateRules(index: TranscriptIndex, rules: readonly RuleSpec[]): readonly RuleResult[] {
  return rules.map((rule) => evaluateRule(index, rule));
}

function evaluateRule(index: TranscriptIndex, rule: RuleSpec): RuleResult {
  switch (rule.kind) {
    case "must_exist":
      return mustExist(index, rule);
    case "must_not_exist":
      return mustNotExist(index, rule);
    case "allowed_tools":
      return allowedTools(index, rule);
    case "field_constraint":
      return fieldConstraint(index, rule);
    case "precedes":
      return precedes(index, rule);
  }
}

function mustExist(index: TranscriptIndex, rule: RuleSpec): RuleResult {
  const matches = index.events.filter((event) => (rule.match ? matchesEvent(event, rule.match) : true));
  return matches.length > 0
    ? pass(rule.id)
    : fail(rule.id, [{ ruleId: rule.id, message: "No matching event exists" }]);
}

function mustNotExist(index: TranscriptIndex, rule: RuleSpec): RuleResult {
  const matches = index.events.filter((event) => (rule.match ? matchesEvent(event, rule.match) : true));
  return matches.length === 0
    ? pass(rule.id)
    : fail(rule.id, matches.map((event) => violation(rule.id, event, "Forbidden event exists")));
}

function allowedTools(index: TranscriptIndex, rule: RuleSpec): RuleResult {
  const allowed = rule.allowed ?? [];
  const violations = index.events
    .filter((event) => event.type === TrajectoryEventType.ToolCall)
    .filter((event) => (rule.match ? matchesEvent(event, rule.match) : true))
    .filter((event) => !allowed.some((pattern) => patternMatches(event.tool, pattern)))
    .map((event) => violation(rule.id, event, `Disallowed tool call: ${event.tool ?? "<missing>"}`));
  return violations.length === 0 ? pass(rule.id) : fail(rule.id, violations);
}

function fieldConstraint(index: TranscriptIndex, rule: RuleSpec): RuleResult {
  if (rule.field === undefined) {
    return fail(rule.id, [{ ruleId: rule.id, message: "field_constraint requires field" }]);
  }
  const violations = index.events
    .filter((event) => (rule.match ? matchesEvent(event, rule.match) : true))
    .filter((event) => !fieldCheck(event, rule))
    .map((event) => violation(rule.id, event, `Field constraint failed for ${rule.field ?? ""}`));
  return violations.length === 0 ? pass(rule.id) : fail(rule.id, violations);
}

function precedes(index: TranscriptIndex, rule: RuleSpec): RuleResult {
  const trigger = rule.trigger;
  const required = rule.required;
  if (trigger === undefined || required === undefined) {
    return fail(rule.id, [{ ruleId: rule.id, message: "precedes requires trigger and required" }]);
  }
  const violations: RuleViolation[] = [];
  for (const event of index.events) {
    if (!matchesEvent(event, trigger)) continue;
    const prior = index.events.filter((candidate) => candidate.seq < event.seq && matchesEvent(candidate, required));
    const match = prior.find((candidate) => {
      if (required.match_field === undefined) return true;
      const triggerValue = fieldValue(event, required.match_field);
      const requiredValue = fieldValue(candidate, required.match_field);
      return triggerValue !== undefined && requiredValue !== undefined && valuesEqual(triggerValue, requiredValue);
    });
    if (match === undefined) {
      violations.push(violation(rule.id, event, "No prior required event matched"));
    }
  }
  return violations.length === 0 ? pass(rule.id) : fail(rule.id, violations);
}

function fieldCheck(event: TrajectoryEvent, rule: RuleSpec): boolean {
  const value = fieldValue(event, rule.field ?? "");
  if (rule.exists === true && value === undefined) return false;
  if (rule.not_exists === true && value !== undefined) return false;
  if (Object.hasOwn(rule, "equals") && !valuesEqual(value, rule.equals)) return false;
  if (Object.hasOwn(rule, "not_equals") && valuesEqual(value, rule.not_equals)) return false;
  if (rule.match_value !== undefined && !patternMatches(value, rule.match_value)) return false;
  if (rule.not_match !== undefined && patternMatches(value, rule.not_match)) return false;
  return true;
}

function pass(ruleId: string): RuleResult {
  return { ruleId, status: "pass", violations: [] };
}

function fail(ruleId: string, violations: readonly RuleViolation[]): RuleResult {
  return { ruleId, status: "fail", violations };
}

function violation(ruleId: string, event: TrajectoryEvent, message: string): RuleViolation {
  return {
    ruleId,
    message,
    seq: event.seq,
    seqRef: formatSeq(event.seq),
    source: event.source,
    eventType: event.type,
    tool: event.tool,
    status: event.status,
    spanId: event.spanId,
    messageSnippet: event.message?.slice(0, 120),
  };
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
bun test src/trajectory/rules.test.ts src/trajectory/match.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trajectory/rules.ts src/trajectory/rules.test.ts
git commit -m "feat: evaluate deterministic trajectory rules"
```

---

## Task 8: Reports And Shared Operation

**Files:**
- Create: `src/trajectory/report.ts`
- Test: `src/trajectory/report.test.ts`
- Create: `src/core/operations/check-trajectory.ts`
- Test: `src/core/operations/check-trajectory.test.ts`
- Modify: `src/core/operations/index.ts`

- [ ] **Step 1: Write failing report test**

Create `src/trajectory/report.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { formatAnnotatedEvents, formatMarkdownReport, summarizeReport } from "./report.js";
import type { TrajectoryCheckReport, TrajectoryEvent } from "./types.js";

const report: TrajectoryCheckReport = {
  name: "common",
  transcriptPath: "transcript.jsonl",
  runtime: "codex",
  eventCount: 2,
  specPaths: ["spec/trajectory/common.yaml"],
  ruleResults: [
    { ruleId: "ok", status: "pass", violations: [] },
    {
      ruleId: "bad",
      status: "fail",
      violations: [{ ruleId: "bad", message: "Denied", seq: 2, seqRef: "[seq:0002]" }],
    },
  ],
  goalResults: [{ goalId: "goal", status: "deferred", message: "LLM goal grading is deferred" }],
  parserWarnings: ["line 5: invalid"],
  summary: { passed: 1, failed: 1, deferred: 1 },
};

describe("report formatting", () => {
  test("summarizes rule and goal statuses", () => {
    expect(summarizeReport(report.ruleResults, report.goalResults)).toEqual({
      passed: 1,
      failed: 1,
      deferred: 1,
    });
  });

  test("formats markdown with sequence references", () => {
    const markdown = formatMarkdownReport(report);
    expect(markdown).toContain("# Trajectory Check Report");
    expect(markdown).toContain("[seq:0002]");
    expect(markdown).toContain("Parser Warnings");
  });

  test("formats annotated event JSONL", () => {
    const events: TrajectoryEvent[] = [
      { seq: 1, type: "ASSISTANT_MESSAGE", runtime: "codex", message: "hi", source: { path: "t", line: 1 } },
    ];
    expect(formatAnnotatedEvents(events)).toContain('[seq:0001] {"seq":1');
  });
});
```

- [ ] **Step 2: Write failing operation test**

Create `src/core/operations/check-trajectory.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTrajectoryOperation } from "./check-trajectory.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "trajectory-op-"));
}

describe("checkTrajectoryOperation", () => {
  test("returns a JSON report for local transcript and spec files", async () => {
    const dir = await tempDir();
    const transcriptPath = join(dir, "transcript.jsonl");
    const specPath = join(dir, "spec.yaml");
    await writeFile(transcriptPath, '{"event":"ASSISTANT_MESSAGE","message":"done"}\n', "utf8");
    await writeFile(specPath, "name: local\nrules:\n  - id: has-message\n    kind: must_exist\n    match:\n      event: ASSISTANT_MESSAGE\n", "utf8");

    const result = await checkTrajectoryOperation({
      transcriptPath,
      specPaths: [specPath],
      runtime: "subprocess",
      format: "json",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected error");
    expect(result.value.report.summary.failed).toBe(0);
    expect(result.value.output).toContain('"eventCount"');
  });

  test("writes annotated log when requested", async () => {
    const dir = await tempDir();
    const transcriptPath = join(dir, "transcript.jsonl");
    const specPath = join(dir, "spec.yaml");
    const annotatedLogPath = join(dir, "annotated.jsonl");
    await writeFile(transcriptPath, '{"event":"ASSISTANT_MESSAGE","message":"done"}\n', "utf8");
    await writeFile(specPath, "name: local\nrules: []\n", "utf8");

    const result = await checkTrajectoryOperation({
      transcriptPath,
      specPaths: [specPath],
      runtime: "subprocess",
      format: "markdown",
      annotatedLogPath,
    });

    expect(result.ok).toBe(true);
    expect(await readFile(annotatedLogPath, "utf8")).toContain("[seq:0001]");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
bun test src/trajectory/report.test.ts src/core/operations/check-trajectory.test.ts
```

Expected: FAIL with missing modules.

- [ ] **Step 4: Implement report formatter**

Create `src/trajectory/report.ts`:

```typescript
import type { GoalResult, RuleResult, TrajectoryCheckReport, TrajectoryEvent } from "./types.js";
import { formatSeq } from "./types.js";

export function summarizeReport(
  ruleResults: readonly RuleResult[],
  goalResults: readonly GoalResult[],
): TrajectoryCheckReport["summary"] {
  return {
    passed: ruleResults.filter((result) => result.status === "pass").length,
    failed: ruleResults.filter((result) => result.status === "fail").length,
    deferred: goalResults.length,
  };
}

export function formatMarkdownReport(report: TrajectoryCheckReport): string {
  const lines: string[] = [
    "# Trajectory Check Report",
    "",
    `- Transcript: ${report.transcriptPath}`,
    `- Runtime: ${report.runtime}`,
    `- Specs: ${report.specPaths.join(", ")}`,
    `- Events: ${report.eventCount.toString()}`,
    "",
    "## Summary",
    "",
    `- Passed: ${report.summary.passed.toString()}`,
    `- Failed: ${report.summary.failed.toString()}`,
    `- Deferred: ${report.summary.deferred.toString()}`,
    "",
  ];

  lines.push("## Failed Rules", "");
  const failed = report.ruleResults.filter((result) => result.status === "fail");
  if (failed.length === 0) lines.push("None.", "");
  for (const result of failed) {
    lines.push(`### ${result.ruleId}`, "");
    for (const violation of result.violations) {
      lines.push(`- ${violation.seqRef ?? ""} ${violation.message}`.trim());
    }
    lines.push("");
  }

  lines.push("## Passed Rules", "");
  for (const result of report.ruleResults.filter((item) => item.status === "pass")) {
    lines.push(`- ${result.ruleId}`);
  }
  lines.push("");

  lines.push("## Deferred Goals", "");
  if (report.goalResults.length === 0) lines.push("None.", "");
  for (const goal of report.goalResults) lines.push(`- ${goal.goalId}: ${goal.message}`);
  lines.push("");

  if (report.parserWarnings.length > 0) {
    lines.push("## Parser Warnings", "");
    for (const warning of report.parserWarnings) lines.push(`- ${warning}`);
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function formatJsonReport(report: TrajectoryCheckReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatAnnotatedEvents(events: readonly TrajectoryEvent[]): string {
  return events.map((event) => `${formatSeq(event.seq)} ${JSON.stringify(compactEvent(event))}`).join("\n") + "\n";
}

function compactEvent(event: TrajectoryEvent): Record<string, unknown> {
  return {
    seq: event.seq,
    type: event.type,
    runtime: event.runtime,
    source: event.source,
    ...(event.tool !== undefined ? { tool: event.tool } : {}),
    ...(event.status !== undefined ? { status: event.status } : {}),
    ...(event.spanId !== undefined ? { spanId: event.spanId } : {}),
    ...(event.parentSpanId !== undefined ? { parentSpanId: event.parentSpanId } : {}),
    ...(event.message !== undefined ? { message: event.message } : {}),
  };
}
```

- [ ] **Step 5: Implement operation**

Create `src/core/operations/check-trajectory.ts`:

```typescript
import { writeFile } from "node:fs/promises";
import { buildTranscriptIndex } from "../../trajectory/indexer.js";
import { evaluateRules } from "../../trajectory/rules.js";
import { loadTrajectorySpecs } from "../../trajectory/spec-loader.js";
import {
  formatAnnotatedEvents,
  formatJsonReport,
  formatMarkdownReport,
  summarizeReport,
} from "../../trajectory/report.js";
import type { ReportFormat, TrajectoryCheckReport, TrajectoryRuntimeInput } from "../../trajectory/types.js";
import type { OperationResult } from "./result.js";
import { err, ok, OperationErrorCode, validationErr } from "./result.js";

export interface CheckTrajectoryInput {
  readonly transcriptPath: string;
  readonly specPaths: readonly string[];
  readonly runtime: TrajectoryRuntimeInput;
  readonly format: ReportFormat;
  readonly annotatedLogPath?: string | undefined;
}

export interface CheckTrajectoryResult {
  readonly report: TrajectoryCheckReport;
  readonly output: string;
}

export async function checkTrajectoryOperation(
  input: CheckTrajectoryInput,
): Promise<OperationResult<CheckTrajectoryResult>> {
  if (input.transcriptPath.trim().length === 0) return validationErr("transcriptPath is required");
  if (input.specPaths.length === 0) return validationErr("at least one spec path is required");

  try {
    const index = await buildTranscriptIndex({
      transcriptPath: input.transcriptPath,
      runtime: input.runtime,
    });
    const spec = await loadTrajectorySpecs(input.specPaths);
    const ruleResults = evaluateRules(index, spec.rules);
    const goalResults = spec.goals.map((goal) => ({
      goalId: goal.id,
      status: "deferred" as const,
      message: "LLM goal grading is deferred in this implementation slice",
    }));
    const summary = summarizeReport(ruleResults, goalResults);
    const report: TrajectoryCheckReport = {
      name: spec.name,
      transcriptPath: input.transcriptPath,
      runtime: index.runtime,
      eventCount: index.events.length,
      specPaths: spec.sourcePaths,
      ruleResults,
      goalResults,
      parserWarnings: index.warnings,
      summary,
    };
    if (input.annotatedLogPath !== undefined) {
      await writeFile(input.annotatedLogPath, formatAnnotatedEvents(index.events), "utf8");
    }
    const output =
      input.format === "json" ? formatJsonReport(report) : formatMarkdownReport(report);
    return ok({ report, output });
  } catch (error) {
    return err({
      code: OperationErrorCode.ValidationError,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
```

Modify `src/core/operations/index.ts`:

```typescript
export type { CheckTrajectoryInput, CheckTrajectoryResult } from "./check-trajectory.js";
export { checkTrajectoryOperation } from "./check-trajectory.js";
```

Place those exports in the operations barrel near the eval operation exports.

- [ ] **Step 6: Run tests**

Run:

```bash
bun test src/trajectory/report.test.ts src/core/operations/check-trajectory.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/trajectory/report.ts src/trajectory/report.test.ts src/core/operations/check-trajectory.ts src/core/operations/check-trajectory.test.ts src/core/operations/index.ts
git commit -m "feat: add trajectory check operation"
```

---

## Task 9: CLI Surface

**Files:**
- Create: `src/cli/commands/check-trajectory.ts`
- Test: `src/cli/commands/check-trajectory.test.ts`
- Modify: `src/cli/main.ts`

- [ ] **Step 1: Write failing CLI tests**

Create `src/cli/commands/check-trajectory.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCheckTrajectoryArgs, runCheckTrajectory } from "./check-trajectory.js";

describe("parseCheckTrajectoryArgs", () => {
  test("parses transcript, repeated specs, runtime, format, and annotated log", () => {
    expect(
      parseCheckTrajectoryArgs([
        "--transcript",
        "t.jsonl",
        "--spec",
        "a.yaml",
        "--spec",
        "b.yaml",
        "--runtime",
        "codex",
        "--format",
        "json",
        "--annotated-log",
        "annotated.jsonl",
      ]),
    ).toEqual({
      transcriptPath: "t.jsonl",
      specPaths: ["a.yaml", "b.yaml"],
      runtime: "codex",
      format: "json",
      annotatedLogPath: "annotated.jsonl",
    });
  });
});

describe("runCheckTrajectory", () => {
  test("writes markdown output through the injected writer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trajectory-cli-"));
    const transcriptPath = join(dir, "transcript.jsonl");
    const specPath = join(dir, "spec.yaml");
    await writeFile(transcriptPath, '{"event":"ASSISTANT_MESSAGE","message":"done"}\n', "utf8");
    await writeFile(specPath, "name: local\nrules: []\n", "utf8");
    const lines: string[] = [];

    await runCheckTrajectory(
      {
        transcriptPath,
        specPaths: [specPath],
        runtime: "subprocess",
        format: "markdown",
      },
      (line) => lines.push(line),
    );

    expect(lines.join("\n")).toContain("# Trajectory Check Report");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/cli/commands/check-trajectory.test.ts
```

Expected: FAIL with missing command module.

- [ ] **Step 3: Implement CLI command**

Create `src/cli/commands/check-trajectory.ts`:

```typescript
import { parseArgs } from "node:util";
import { checkTrajectoryOperation, type CheckTrajectoryInput } from "../../core/operations/index.js";
import type { ReportFormat, TrajectoryRuntimeInput } from "../../trajectory/types.js";

const RUNTIMES = new Set<TrajectoryRuntimeInput>([
  "auto",
  "acpx",
  "codex",
  "claude-stream-json",
  "subprocess",
  "unknown",
]);
const FORMATS = new Set<ReportFormat>(["markdown", "json"]);

export function parseCheckTrajectoryArgs(argv: readonly string[]): CheckTrajectoryInput {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      transcript: { type: "string" },
      spec: { type: "string", multiple: true },
      runtime: { type: "string", default: "auto" },
      format: { type: "string", default: "markdown" },
      "annotated-log": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.transcript === undefined) throw new Error("--transcript is required");
  const runtime = values.runtime ?? "auto";
  if (!RUNTIMES.has(runtime as TrajectoryRuntimeInput)) {
    throw new Error(`Invalid runtime: ${runtime}`);
  }
  const format = values.format ?? "markdown";
  if (!FORMATS.has(format as ReportFormat)) {
    throw new Error(`Invalid format: ${format}`);
  }

  return {
    transcriptPath: values.transcript,
    specPaths: values.spec ?? ["spec/trajectory/common.yaml"],
    runtime: runtime as TrajectoryRuntimeInput,
    format: format as ReportFormat,
    ...(values["annotated-log"] !== undefined ? { annotatedLogPath: values["annotated-log"] } : {}),
  };
}

export async function runCheckTrajectory(
  input: CheckTrajectoryInput,
  writer: (line: string) => void = console.log,
): Promise<void> {
  const result = await checkTrajectoryOperation(input);
  if (!result.ok) throw new Error(result.error.message);
  writer(result.value.output.trimEnd());
}
```

Modify `src/cli/main.ts` command registry:

```typescript
{
  name: "check-trajectory",
  description: "Check a local agent transcript against trajectory rules",
  needsStore: false,
  helpText: `grove check-trajectory — check a local agent transcript

Usage:
  grove check-trajectory --transcript <path> [--spec <path>] [--runtime auto|acpx|codex|claude-stream-json|subprocess] [--format markdown|json] [--annotated-log <path>]`,
  handler: async (args) => {
    const { parseCheckTrajectoryArgs, runCheckTrajectory } = await import("./commands/check-trajectory.js");
    await runCheckTrajectory(parseCheckTrajectoryArgs(args));
  },
},
```

Add it under `Advanced` in `printUsage()`:

```text
  grove check-trajectory --transcript <path> Check local transcript rules
```

- [ ] **Step 4: Run CLI tests**

Run:

```bash
bun test src/cli/commands/check-trajectory.test.ts src/cli/main.integration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/check-trajectory.ts src/cli/commands/check-trajectory.test.ts src/cli/main.ts
git commit -m "feat: add check-trajectory CLI"
```

---

## Task 10: MCP Surface And Parity

**Files:**
- Create: `src/mcp/tools/trajectory.ts`
- Test: `src/mcp/tools/trajectory.test.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/core/operations/parity-matrix.test.ts`
- Modify: `docs/parity-matrix.md`

- [ ] **Step 1: Write failing MCP test**

Create `src/mcp/tools/trajectory.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpDeps } from "../deps.js";
import type { TestMcpDeps } from "../test-helpers.js";
import { createTestMcpDeps } from "../test-helpers.js";
import { registerTrajectoryTools } from "./trajectory.js";

async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean | undefined; text: string }> {
  const registeredTools = (
    server as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
    }
  )._registeredTools;
  const tool = registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  const result = (await tool.handler(args)) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  return { isError: result.isError, text: result.content[0]?.text ?? "" };
}

describe("grove_check_trajectory", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerTrajectoryTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("returns trajectory report JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trajectory-mcp-"));
    const transcriptPath = join(dir, "transcript.jsonl");
    const specPath = join(dir, "spec.yaml");
    await writeFile(transcriptPath, '{"event":"ASSISTANT_MESSAGE","message":"done"}\n', "utf8");
    await writeFile(specPath, "name: local\nrules: []\n", "utf8");

    const result = await callTool(server, "grove_check_trajectory", {
      transcriptPath,
      specPaths: [specPath],
      runtime: "subprocess",
      format: "json",
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.report.eventCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/mcp/tools/trajectory.test.ts
```

Expected: FAIL with missing MCP tool module.

- [ ] **Step 3: Implement MCP tool**

Create `src/mcp/tools/trajectory.ts`:

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkTrajectoryOperation } from "../../core/operations/index.js";
import type { ReportFormat, TrajectoryRuntimeInput } from "../../trajectory/types.js";
import type { McpDeps } from "../deps.js";
import { toMcpResult } from "../operation-adapter.js";

const runtimeSchema = z.enum(["auto", "acpx", "codex", "claude-stream-json", "subprocess"]);
const formatSchema = z.enum(["markdown", "json"]);

export function registerTrajectoryTools(server: McpServer, _deps: McpDeps): void {
  server.registerTool(
    "grove_check_trajectory",
    {
      description:
        "Check a local agent transcript JSONL file against deterministic Grove trajectory YAML rules.",
      inputSchema: {
        transcriptPath: z.string().min(1),
        specPaths: z.array(z.string().min(1)).min(1).default(["spec/trajectory/common.yaml"]),
        runtime: runtimeSchema.default("auto"),
        format: formatSchema.default("json"),
        annotatedLogPath: z.string().min(1).optional(),
      },
    },
    async (args) => {
      return toMcpResult(
        await checkTrajectoryOperation({
          transcriptPath: args.transcriptPath,
          specPaths: args.specPaths,
          runtime: args.runtime as TrajectoryRuntimeInput,
          format: args.format as ReportFormat,
          ...(args.annotatedLogPath !== undefined ? { annotatedLogPath: args.annotatedLogPath } : {}),
        }),
      );
    },
  );
}
```

Modify `src/mcp/server.ts`:

```typescript
import { registerTrajectoryTools } from "./tools/trajectory.js";
```

Add registration near query tools:

```typescript
if (preset?.queries !== false) {
  registerQueryTools(server, deps);
  registerTrajectoryTools(server, deps);
}
```

Modify `src/core/operations/parity-matrix.test.ts`:

```typescript
{ operation: "checkTrajectoryOperation", mcpTool: "grove_check_trajectory" },
```

Add the same operation to the CLI shared list:

```typescript
{ operation: "checkTrajectoryOperation", cliCommand: "check-trajectory" },
```

Add `"checkTrajectoryOperation"` to `expectedExports`.

Modify `docs/parity-matrix.md` capability table:

```markdown
| check trajectory | Y | Y | - | - | shared |
```

- [ ] **Step 4: Run MCP and parity tests**

Run:

```bash
bun test src/mcp/tools/trajectory.test.ts src/core/operations/parity-matrix.test.ts src/mcp/server.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/trajectory.ts src/mcp/tools/trajectory.test.ts src/mcp/server.ts src/core/operations/parity-matrix.test.ts docs/parity-matrix.md
git commit -m "feat: add trajectory MCP tool"
```

---

## Task 11: End-To-End Verification

**Files:**
- Modify as needed from prior tasks only.

- [ ] **Step 1: Run focused trajectory tests**

Run:

```bash
bun test src/trajectory src/core/operations/check-trajectory.test.ts src/cli/commands/check-trajectory.test.ts src/mcp/tools/trajectory.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run Biome check**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 4: Run full test suite if focused checks are clean**

Run:

```bash
bun test
```

Expected: PASS.

- [ ] **Step 5: Manual CLI smoke test**

Run:

```bash
bun run src/cli/main.ts check-trajectory \
  --transcript tests/fixtures/trajectory/codex-transcript.jsonl \
  --spec spec/trajectory/common.yaml \
  --runtime codex \
  --format markdown
```

Expected: output starts with `# Trajectory Check Report` and includes `Runtime: codex`.

- [ ] **Step 6: Final commit for verification-only fixes**

If verification required small fixes, commit them:

```bash
git add src docs spec tests
git commit -m "test: verify trajectory checker"
```

If there were no verification-only changes, skip this commit and record the clean command output in the final handoff.

---

## Self-Review Notes

Spec coverage:

- Runtime parser support for `acpx`, Codex, Claude Code `stream-json`, and subprocess is covered by Tasks 4 and 5.
- `TranscriptIndex`, sequence markers, and span indexes are covered by Tasks 1 and 3.
- YAML spec loading and duplicate-rule validation are covered by Task 6.
- Five deterministic rule kinds are covered by Task 7.
- Markdown, JSON, and annotated sidecar reports are covered by Task 8.
- CLI and MCP surfaces are covered by Tasks 9 and 10.
- Default `common.yaml` and parity docs are covered by Tasks 6 and 10.
- LLM goal grading remains intentionally deferred in Task 8 goal result handling.

Type consistency:

- Operation name is `checkTrajectoryOperation`.
- CLI command is `check-trajectory`.
- MCP tool name is `grove_check_trajectory`.
- Runtime input type is `TrajectoryRuntimeInput`.
- Report object type is `TrajectoryCheckReport`.

No out-of-scope server route, SQLite persistence, or live log middleware is included in this implementation plan.
