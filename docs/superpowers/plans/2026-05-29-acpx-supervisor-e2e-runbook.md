# AcpxSupervisor respawn E2E — Runbook (#273, Phase 5.3)

> **Status: the E2E script `tests/e2e/acpx-supervisor-respawn-tmux.ts` is authored but NOT-YET-RUN.**
> It was written without executing against a live grove+Nexus stack. Treat its
> assertions as *intended*, not *verified*, until a real run goes green. Do not
> claim the respawn path is end-to-end validated on the strength of the script alone.

## What it proves (when run green)

A real acpx agent, spawned through `AcpxSupervisor` (`GROVE_SUPERVISOR=1`), is
`kill -9`'d mid-flight and the supervisor:

1. detects the death (Phase 1 `onDisconnect`),
2. respawns a fresh session within the shared runtime (Phase 3),
3. surfaces it on the bound `AgentTask` as a `SessionLost=True` condition while
   keeping the task `Running` — not `Failed` (Phase 4 wiring),
4. binds a new `status.sessionId` (respawn, not the dead session).

All four are observable over `GET /api/agent-tasks/:id`.

## What it deliberately does NOT assert — and why

**Monotonic `seq` across the kill boundary is not wire-observable.** The
supervisor stamps `seq` on the in-process `AcpRuntimeEvent` sink
(`src/core/acpx-supervisor.ts` → `routeEvent`), which feeds `AcpSessionStore`
(TUI-local) only. It is **not** exposed on any HTTP/SSE endpoint today, so a
black-box E2E cannot see it. Seq continuity is instead covered by the unit test:

```
src/core/acpx-supervisor.respawn.test.ts
  → "seq is strictly increasing across turns and respawn (no reset)"
```

If wire-level seq observability is ever wanted, that's a separate follow-up
(expose `seq` on the agent-event/watch stream), out of scope for #273.

## Prerequisites

- Docker up with a healthy Nexus stack (this environment had several
  `nexus-*-nexus-1 (healthy)` containers — `docker ps`), OR a local grove server
  the script can reach on `SERVER_PORT`.
- A real ACP adapter installed for the chosen `runtime` (default `codex` →
  `@zed-industries/codex-acp`). Without it, spawn fails before respawn is testable.
- `tmux` available.
- Valid agent auth so the spawned agent can reach Nexus (per project memory on
  per-worktree key isolation — run from a fresh dir; the script does `git init`
  + a fresh temp workdir per run).

## Run

```bash
GROVE_SUPERVISOR=1 bun run tests/e2e/acpx-supervisor-respawn-tmux.ts
# flags: --keep (leave tmux+workdir), --attach (print attach cmd & wait), --timeout <ms>
```

## Two spots that will likely need a tweak on first real run

Both are marked `TODO(verify-on-stack)` in the script:

1. **acpx child-PID discovery** (`findAcpxChildPid`). The script `pgrep`s for
   `codex-acp|claude-agent-acp|gemini .*--acp|acp` and kills the highest PID.
   On a real box, run `pgrep -fl` once after the agent binds, confirm the exact
   adapter argv, and pin the pattern (and ideally scope to descendants of the
   grove server PID so a sibling test's agent isn't killed).

2. **AgentTask PUT schema + readiness**. The script PUTs
   `{ id, worktree, runtime, role, prompt, dependsOn, generation, createdAt }`.
   Confirm against `src/server/routes/agent-tasks.ts` (`putAgentTaskSpec`) and
   the `AgentTaskSpecRecord` shape; adjust fields if the server rejects the body.
   Also confirm the bind actually produces `phase: "Running"` + a `sessionId`
   (the controller must be enabled — the script sets `GROVE_TASK_CONTROLLER=1`).

## Validate against Nexus, not local SQLite

Per project memory (`feedback_e2e_use_nexus`): production reads/writes go to
Nexus. Point the server at the running Nexus stack (env/keys) rather than the
SQLite fallback, and confirm the `AgentTask` you poll is the Nexus-backed one.

## Done = green + observed

Per `feedback_no_workarounds` / `feedback_no_e2e_shortcuts`: the task is only
"E2E validated" once this script runs and prints its `PASS:` line on a real
stack, with the `SessionLost` condition + sessionId change actually observed.
Until then this is a prepared harness, not a passing test.
