# Deterministic Loop Runner - Design

- **Issue**: [#340](https://github.com/windoliver/grove/issues/340)
- **Date**: 2026-05-05
- **Status**: Approved by direct user instruction

## Goal

Add an external deterministic orchestration loop for multi-agent sessions. The
loop owns stop decisions outside the LLM, records a semantic final status, and
persists iteration state durably in Nexus so operators can recover why a run
stopped.

## Non-goals

- Replacing contribution policy enforcement or contract stop-condition checks.
- Adding a new LLM planning provider in this PR. The runner accepts planner
  output as a string and validates it; callers can supply real planner output
  later.
- Changing the public meaning of `grove_done`. It remains an agent signal, but
  the orchestrator no longer treats one role's done signal as whole-session
  completion.

## Approach

Implement a reusable `GroveLoopRunner` in `src/core/loop-runner.ts`. It runs:

1. assessment construction
2. roadmap parsing with balanced-brace JSON extraction
3. deterministic iteration execution
4. durable workflow state updates
5. final status selection

The runner is generic over the iteration callback so tests can exercise it
without spawning agents, while `SessionOrchestrator` and the CLI can use it for
session execution.

Final stop statuses are a typed enum:

```text
achieved
plateau
max_iterations
interrupted
error
```

The status is stored on session records as `stopStatus` and exposed through the
HTTP API as `stopStatus`. `stopReason` remains a human-readable string for
backwards compatibility.

## Durable State

Add a Nexus workflow store backed by VFS paths:

```text
/zones/{zoneId}/workflows/{workflowId}.json
```

The stored state includes the workflow ID, session ID, assessment, roadmap,
iteration summaries, current best score, no-improvement count, status, reason,
timestamps, and version. Writes use the existing Nexus client abstraction, with
plain overwrite semantics for this first full integration. The runner writes at
start, after each iteration, and at completion.

## Plateau Detection

Plateau detection uses a deterministic numeric score:

- maximize by default
- `improvementThreshold` defaults to `0.01`
- `maxNoImprovementRounds` defaults to `5`
- an iteration improves only when the absolute score delta over the previous
  best is at least the threshold

The runner also supports minimize direction so metric-oriented workflows can
use loss-style scores.

## SIGINT

Add a small interrupt controller in the core loop module. First SIGINT requests
graceful interruption, letting the runner finish the current await boundary and
persist `interrupted`. A second SIGINT calls the supplied force-exit callback,
which the CLI wires to `process.exit(130)`.

## Session Integration

`SessionOrchestrator` gains semantic stop status support and all-role done
detection. One role calling `grove_done` records that role as done and only
stops the session once every spawned role has signaled done. Idle completion
maps to `achieved`, timeout maps to `max_iterations`, manual/user stop maps to
`interrupted`, and unexpected failures map to `error`.

The headless `grove session start` path wraps `SessionOrchestrator` with
`GroveLoopRunner`. In Nexus mode it also creates `NexusWorkflowStore` so loop
state is written durably while the session runs.

## Testing

- Core runner tests cover fallback roadmap parsing, balanced braces, achieved,
  plateau, max-iteration, interrupted, and error statuses.
- Nexus workflow-store tests cover path safety, write/read, list, and overwrite.
- Session orchestrator tests cover all-role done semantics and stop status.
- SQLite/session API tests cover `stop_status` persistence and response mapping.
- TUI tests cover rendering semantic stop status where session rows are shown.
