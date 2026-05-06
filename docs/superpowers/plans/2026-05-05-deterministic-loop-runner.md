# Deterministic Loop Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement issue #340 end to end: deterministic external loop runner, semantic stop status, all-role done handling, SIGINT escalation, plateau/max-iteration detection, and durable Nexus workflow state.

**Architecture:** Add a generic core loop runner with schemas and stop logic, a Nexus-backed workflow-state store, and small integration points in sessions, CLI, HTTP mapping, and TUI. Keep `stopReason` for compatibility and add `stopStatus` for machine-readable behavior.

**Tech Stack:** Bun 1.3.x, TypeScript strict mode, `bun:test`, Zod, existing Nexus VFS client, SQLite migrations through the existing local store.

**Spec:** `docs/superpowers/specs/2026-05-05-deterministic-loop-runner-design.md`

**Issue:** [#340](https://github.com/windoliver/grove/issues/340)

---

## File Map

**Create:**
- `src/core/loop-runner.ts`
- `src/core/loop-runner.test.ts`
- `src/nexus/nexus-workflow-store.ts`
- `src/nexus/nexus-workflow-store.test.ts`

**Modify:**
- `src/core/session.ts`
- `src/core/session-manager.ts`
- `src/core/session-orchestrator.ts`
- `src/core/session-orchestrator.test.ts`
- `src/local/sqlite-store.ts`
- `src/local/sqlite-goal-session-store.ts`
- `src/local/sqlite-goal-session-store.test.ts`
- `src/nexus/vfs-paths.ts`
- `src/nexus/vfs-paths.test.ts`
- `src/nexus/index.ts`
- `src/nexus/nexus-session-store.ts`
- `src/server/routes/sessions.ts`
- `src/tui/provider-shared.ts`
- `src/tui/views/welcome/session-row.tsx`
- `src/tui/views/welcome/session-row.test.ts`
- `src/cli/commands/session.ts`
- `src/core/index.ts`

## Tasks

- [ ] Add failing core tests for roadmap parsing and deterministic stop statuses.
- [ ] Implement `LoopStopStatus`, schemas, balanced-brace extraction, fallback roadmap, interrupt controller, and `GroveLoopRunner`.
- [ ] Add failing Nexus workflow-store tests and VFS path tests.
- [ ] Implement workflow VFS paths and `NexusWorkflowStore`.
- [ ] Add failing session persistence/API tests for `stopStatus`.
- [ ] Add `stopStatus` to core session types, SQLite schema/migration, Nexus session records, and API/TUI mapping.
- [ ] Add failing orchestrator tests for all-role done and semantic stop status.
- [ ] Update `SessionOrchestrator` stop handling and CLI `session start` loop integration.
- [ ] Update TUI session row status text for semantic stop statuses.
- [ ] Run focused tests, then `bun run typecheck`, `bun run check`, and relevant broader tests.
