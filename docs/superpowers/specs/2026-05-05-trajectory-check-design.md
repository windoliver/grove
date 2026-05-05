# Trajectory Check - Design

- **Issue**: [#339](https://github.com/windoliver/grove/issues/339)
- **Date**: 2026-05-05
- **Status**: Approved
- **Related**: [#211](https://github.com/windoliver/grove/issues/211), [#375](https://github.com/windoliver/grove/issues/375), [#376](https://github.com/windoliver/grove/issues/376), [#378](https://github.com/windoliver/grove/issues/378), [#379](https://github.com/windoliver/grove/issues/379)

## Goal

Add a local trajectory checker that normalizes agent transcript JSONL into a
single event index, runs deterministic YAML rules, and exposes the same report
through a CLI command and MCP tool.

The first implementation slice supports local transcript files for all runtime
families named in issue #339: `acpx`, Codex, Claude Code `stream-json`, and
plain subprocess. It does not run LLM goal grading.

## Non-goals

- LLM-graded goals. Goal blocks are parsed and reported as deferred so #211 can
  attach grading later.
- Live transcript middleware that writes `[seq:NNNN]` into every runtime's
  `info.log` and `debug.log`. This slice emits sequence cross-references in the
  report and optional annotated sidecar files.
- Persisting trajectory events into Grove's SQLite stores. The checker is a
  local post-hoc analysis command over files.
- Replacing WorkBlock, AgentTask, AutonomyProfile, or RunHealth models. The
  event schema reserves compatible event families, but the canonical models are
  owned by #375, #376, #378, and #379.
- Remote transcript fetching, server routes, or hosted evaluation runs.

## Command Shape

CLI:

```bash
grove check-trajectory \
  --transcript transcript.jsonl \
  --spec spec/trajectory/common.yaml \
  --runtime auto \
  --format markdown
```

Flags:

| Flag | Default | Behavior |
| --- | --- | --- |
| `--transcript <path>` | required | Local JSONL transcript file to evaluate |
| `--spec <path>` | `spec/trajectory/common.yaml` | YAML check spec; may be passed multiple times |
| `--runtime auto|acpx|codex|claude-stream-json|subprocess` | `auto` | Parser selection |
| `--format markdown|json` | `markdown` | Report output format |
| `--annotated-log <path>` | unset | Optional sidecar file that writes one normalized event per line with `[seq:NNNN]` |

MCP:

- Tool name: `grove_check_trajectory`
- Input fields mirror the CLI: `transcriptPath`, `specPaths`, `runtime`,
  `format`, and optional `annotatedLogPath`.
- The tool reads local files only. It returns the same structured result the
  CLI uses, formatted through the existing MCP operation adapter.

The CLI command is registered in `src/cli/main.ts`. The MCP tool is registered
through `src/mcp/server.ts` and lives in `src/mcp/tools/trajectory.ts`.

## Architecture

```
transcript.jsonl
  -> runtime parser
  -> TranscriptIndex
  -> YAML spec loader
  -> deterministic rule engine
  -> report formatter
  -> CLI / MCP
```

Files:

- `src/trajectory/types.ts`: event, parser, spec, rule, and report contracts.
- `src/trajectory/indexer.ts`: JSONL loading, parser selection, sequence
  assignment, span indexing, and event lookup helpers.
- `src/trajectory/parsers/acpx.ts`: ACP JSON-RPC NDJSON parser using existing
  ACP message semantics where practical.
- `src/trajectory/parsers/codex.ts`: tolerant parser for Codex transcript JSONL
  shapes and Codex ACP-compatible output.
- `src/trajectory/parsers/claude-stream-json.ts`: parser for Claude Code
  `stream-json`, including `parent_tool_use_id` span mapping.
- `src/trajectory/parsers/subprocess.ts`: parser for plain stdout/stderr JSONL
  and line-oriented subprocess logs.
- `src/trajectory/spec-loader.ts`: YAML parsing and validation.
- `src/trajectory/match.ts`: event and dotted-field matching helpers.
- `src/trajectory/rules.ts`: five deterministic rule kinds.
- `src/trajectory/report.ts`: markdown, JSON, and annotated-log formatting.
- `src/core/operations/check-trajectory.ts`: operation wrapper shared by CLI
  and MCP.
- `src/cli/commands/check-trajectory.ts`: CLI parser and runner.
- `src/mcp/tools/trajectory.ts`: MCP registration.
- `spec/trajectory/common.yaml`: default deterministic rules.

## Transcript Index

Every normalized event has a monotonic sequence number assigned after parsing,
starting at `1`. Human-facing references use zero-padded markers:
`[seq:0001]`, `[seq:0002]`, and so on.

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
```

The extra event families from the issue comment are part of the schema now, but
runtime parsers only emit them when transcript payloads carry enough
information. This keeps the shape compatible with future timeline and health
views without inventing their stores.

`TrajectoryEvent` fields:

- `seq`: assigned by `TranscriptIndex`.
- `type`: one of `TrajectoryEventType`.
- `runtime`: `acpx`, `codex`, `claude-stream-json`, `subprocess`, or
  `unknown`.
- `timestamp`: ISO string when present in the transcript.
- `sessionId`, `turnId`, `agentId`, `role`: optional identity fields.
- `spanId`: stable event span, usually a tool call id or generated parser id.
- `parentSpanId`: delegation parent span, populated from
  `parent_tool_use_id` or equivalent fields.
- `tool`: canonical tool name when known.
- `status`: lifecycle status when known.
- `input`, `output`, `message`, `error`: normalized payload fields.
- `raw`: original parsed JSON value or raw text for auditability.
- `source`: `{ path, line }` for exact file provenance.

The index keeps:

- `events`: events in sequence order.
- `bySeq`: direct lookup.
- `bySpanId`: span lookup for delegation and tool result joins.
- `childrenByParentSpanId`: delegation tree lookup.

Malformed JSONL lines produce `RAW` events with `error` describing the parse
failure. Parser exceptions are captured per line so one bad line does not hide
later evidence.

## Runtime Parsers

### `acpx`

The ACP parser accepts JSON-RPC NDJSON like the fixtures under
`tests/fixtures/acp/`. It maps:

- `session/new` result to `AGENT_START`.
- `session/update` `agent_message_chunk` and `user_message_chunk` to
  `ASSISTANT_MESSAGE` when emitted by the agent side, preserving raw payload.
- `session/update` `tool_call` to `TOOL_CALL`.
- `session/update` `tool_call_update` with terminal status or output to
  `TOOL_RESULT`.
- permission request signals to `PERMISSION_WAIT`.
- denied or cancelled permission responses, when present, to
  `PERMISSION_DENIED` and `PERMISSION_DECISION`.
- final result frames with context compaction signals to `COMPACTION` only
  when the raw payload explicitly names compaction.

Unknown `session/update` kinds become `RAW` events.

### `codex`

The Codex parser handles two shapes:

- Codex ACP-compatible NDJSON, using the same event mappings as `acpx` with
  `runtime: "codex"`.
- Codex transcript records that contain common fields such as `type`, `role`,
  `message`, `tool`, `tool_name`, `call_id`, `id`, `input`, `output`,
  `error`, `status`, and `timestamp`.

It is intentionally tolerant because Codex transcript formats have changed
over time. Records that cannot be confidently classified become `RAW`, but
dotted-field rule matching can still inspect their `raw` payload.

### `claude-stream-json`

The Claude parser handles Claude Code `stream-json` records. It maps:

- assistant text deltas to `ASSISTANT_MESSAGE`.
- `tool_use` / `tool_call` records to `TOOL_CALL`.
- `tool_result` records to `TOOL_RESULT`.
- `subagent` or task-style tool calls to `DELEGATION`.
- completion or result records for a delegated span to `DELEGATION_RETURN`.
- permission denial records and blocked tool results to `PERMISSION_DENIED`.

When a record carries `parent_tool_use_id`, the parser sets
`parentSpanId = parent_tool_use_id` and `spanId` to the current `tool_use_id`,
`tool_call_id`, or generated id. This makes subagent delegation structurally
visible in the same index used by native Grove delegation.

### `subprocess`

The subprocess parser supports plain local command transcripts with weaker
semantics:

- JSONL records with `event`, `type`, or `kind` are mapped when they match a
  known event name.
- JSONL records with `stream: "stdout"` or `stream: "stderr"` become
  `ASSISTANT_MESSAGE` unless they carry a tool or permission signal.
- Non-JSON lines become `RAW` events with `message` set to the line text.
- Process start records become `AGENT_START` when they include command or pid
  fields.

Subprocess output cannot reliably reconstruct tool calls unless the producer
wrote structured events. The parser keeps raw evidence visible rather than
pretending a stronger structure exists.

### Auto Detection

`auto` samples the first parseable records:

1. JSON-RPC `session/update` or `session/new` means `acpx`, unless provider
   metadata identifies Codex, then `codex`.
2. Claude `stream-json` fields such as `parent_tool_use_id`, `tool_use_id`, or
   `type: "assistant"` plus Claude-style content blocks mean
   `claude-stream-json`.
3. Codex-specific metadata or common Codex transcript event names mean `codex`.
4. Everything else falls back to `subprocess`.

The selected runtime is recorded in the report. Users can override it when auto
detection is wrong.

## YAML Spec

Specs are YAML files with `name`, `rules`, and optional `goals`.

```yaml
name: review-loop-default
rules:
  - id: no-permission-denials
    kind: must_not_exist
    match:
      event: PERMISSION_DENIED

  - id: edits-require-backup
    kind: precedes
    trigger:
      event: TOOL_CALL
      tool: "apply_patch|edit_file"
      field_not_match:
        input.patch: "--- /dev/null*"
    required:
      event: TOOL_CALL
      tool: backup_file
      match_field: input.file_path

goals:
  - id: user-goal-achieved
    criteria: The agent completed the requested task and reported results clearly.
    evidence: [delegation, agent_start, assistant_message]
```

Event names in YAML accept either canonical uppercase names or lowercase aliases
such as `tool_call`. Tool patterns use simple glob alternation, so
`"apply_patch|edit_file"` matches either tool name exactly. Dotted field paths
can read normalized event fields and `raw` payload fields.

Multiple `--spec` files are merged in order. Duplicate rule ids are rejected
with a validation error so operators do not accidentally shadow rules.

## Rule Engine

The engine returns `pass`, `fail`, or `deferred` checks. Deterministic rules
never call an LLM.

### `must_exist`

Passes when at least one event matches `match`.

Violation: one report entry with the rule id and a message stating that no
matching event exists.

### `must_not_exist`

Passes when no events match `match`.

Violation: one report entry per matching event, each with that event's
`[seq:NNNN]`.

### `allowed_tools`

Validates every `TOOL_CALL` against an allowlist. Optional `match` can scope the
allowlist to a subset of events.

Violation: one report entry per disallowed tool call.

### `field_constraint`

Validates a dotted field path against `equals`, `not_equals`, `match`,
`not_match`, `exists`, or `not_exists`.

Violation: one report entry per matching event whose field check fails.

### `precedes`

For every event matching `trigger`, finds a prior event matching `required`.
If `required.match_field` is set, the required event must have the same field
value as the trigger event at that dotted path. If the required field is absent
from either side, the trigger fails with an explicit missing-field reason.

Violation: one report entry per trigger with no matching prior evidence.

This rule supports the issue's backup-before-modify example without needing a
custom rule.

## Reporting

JSON report shape:

```typescript
interface TrajectoryCheckReport {
  readonly name: string;
  readonly transcriptPath: string;
  readonly runtime: string;
  readonly eventCount: number;
  readonly ruleResults: readonly RuleResult[];
  readonly goalResults: readonly GoalResult[];
  readonly summary: {
    readonly passed: number;
    readonly failed: number;
    readonly deferred: number;
  };
}
```

Markdown report sections:

- header with transcript, runtime, spec names, and event count
- summary counts
- failed deterministic rules first
- passed deterministic rules
- deferred goals
- parser warnings

Violation entries include:

- `ruleId`
- `message`
- `seq` and `[seq:NNNN]` when tied to a specific event
- `source.path` and `source.line`
- compact event context: type, tool, status, span, and message snippet

Annotated sidecar output writes JSONL where every line starts with
`[seq:NNNN] ` followed by a compact normalized event JSON object. This gives
operators a grep target immediately while leaving live log middleware for a
later integration slice.

## Default Spec

`spec/trajectory/common.yaml` ships conservative rules:

- no permission denials
- every transcript has at least one agent start or assistant message
- tool calls must have a tool name
- tool results must reference a span id when one is present in the runtime
- delegated returns must reference a known parent span when parent metadata is
  present

The default spec avoids Grove-specific workflow rules such as
backup-before-modify because those can be too opinionated for research,
support, incident, and subprocess sessions. Workflow presets can add local
`mr-*.yaml` specs later.

## Error Handling

- Missing transcript: validation error.
- Missing spec: validation error.
- Invalid YAML: validation error with file path and parser message.
- Unknown rule kind: validation error with rule id.
- Invalid dotted field path syntax: validation error with rule id.
- Bad JSONL line: parser warning plus `RAW` event; checking continues.
- No parseable events: report is produced with failed default evidence rules.
- Annotated-log write failure: operation returns an error after rule evaluation
  because the user explicitly requested that file.

## Testing

All tests use `bun:test`.

Parser fixtures:

- ACP/Codex fixtures reuse `tests/fixtures/acp/codex-simple.ndjson`,
  `claude-simple.ndjson`, and `claude-tool-call.ndjson`.
- New `tests/fixtures/trajectory/claude-stream-json.jsonl` covers
  `parent_tool_use_id` delegation.
- New `tests/fixtures/trajectory/codex-transcript.jsonl` covers Codex native
  transcript records.
- New `tests/fixtures/trajectory/subprocess.log` covers mixed JSON and text
  subprocess output.

Unit tests:

- index sequence assignment and lookup.
- runtime auto detection.
- parser mapping for each runtime.
- dotted field lookup, glob matching, and negative guards.
- each rule kind, including `precedes` with `match_field`.
- YAML spec validation and duplicate rule rejection.
- markdown, JSON, and annotated-log formatting.

Surface tests:

- CLI argument parsing and a temp-file end-to-end check.
- MCP tool registration and result shape.
- parity matrix update for the new shared capability.

## Integration Path

This slice creates the deterministic post-hoc layer that #211 can call later.
Future work can add:

- LLM goal grading over `goalResults`.
- transcript middleware that emits `[seq:NNNN]` into live `info.log` and
  `debug.log`.
- persistence of trajectory events for timeline, health, diagnostics, and daily
  digest surfaces.
- session-local spec discovery such as `common.yaml` plus `mr-*.yaml`.
