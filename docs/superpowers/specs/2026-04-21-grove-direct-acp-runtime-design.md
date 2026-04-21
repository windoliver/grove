# Design: Grove Direct ACP Runtime

**Date:** 2026-04-21
**Supersedes / subsumes:** [#272](https://github.com/windoliver/grove/issues/272) — `feat(runtime): pluggable permission resolver at the acpx boundary`.
**Related:** [#193](https://github.com/windoliver/grove/issues/193) supervision hero surface · [#259](https://github.com/windoliver/grove/issues/259) typed ACP stream (shipped) · [#319](https://github.com/windoliver/grove/issues/319) wire-session binding.

## Problem

Grove currently spawns `acpx` as a CLI subprocess (`src/core/acpx-runtime.ts`). acpx is the ACP client; grove sees only its NDJSON re-serialisation of agent traffic. This architecture blocks or distorts four things the product needs:

1. **Permission resolution.** acpx fields `session/request_permission` internally and replies via `--approve-all` / `--non-interactive-permissions`. The permission request never reaches grove. Issue #272 proposed an acpx upstream patch to surface a resolver; research found the simpler fix is for grove to *be* the ACP client.
2. **Cancel.** `AcpxRuntime` SIGINTs the acpx child (line 449) because ACP's `session/cancel` is not wired through acpx CLI arguments. Turns can't carry a proper `stopReason: "cancelled"`.
3. **Per-turn cold start.** `startTurn` spawns a fresh acpx child per prompt (line 352). Every turn pays the `initialize → session/new → session/load → session/prompt` handshake. #319's `wireSessionId` forwarding is a workaround for this.
4. **Stream fidelity.** Agent → acpx (typed) → NDJSON → grove (re-parse typed). Each hop loses structure; fs/terminal requests from the agent are invisible because they terminate inside acpx as ACP client methods.

Research (`/tmp/acpx/src/acp/client.ts` ≈ 1436 LOC, total ≈ 3500 LOC) shows grove uses ~20 % of acpx. The used slice — `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/update` parsing, `session/request_permission` routing, provider install detection — is ≈ 500–600 LOC directly on `@agentclientprotocol/sdk` (v0.19.1, Apache-2.0, zero runtime deps).

## Goals

- Replace `AcpxRuntime` with `AcpRuntime` that embeds `@agentclientprotocol/sdk` and speaks ACP directly to provider binaries (`codex-acp`, `claude-agent-acp`, `gemini --acp`).
- Support a pluggable `PermissionResolver` on `AcpRuntime` whose signature is an ACP `requestPermission` handler — no grove-native decision type, reuse ACP's `PermissionOption` / `PermissionOptionKind` verbatim.
- One persistent agent subprocess per session; handshake once, multi-turn over the same connection.
- Real `session/cancel` producing `stopReason: "cancelled"`.
- Live `session/update` stream delivered to grove's existing typed `AcpxTurn` contract (shipped in #259) so downstream consumers (`AcpMessageSink`, `SessionStore`, `publishTurnToNexus`) work unchanged.
- Feature flag (`GROVE_RUNTIME=acp|acpx`) for a bounded cutover window. Default starts at `acpx` (opt-in to `acp`) and flips to `acp` after parity tests ship; `acpx` remains rollback-available for one release, then deleted.

## Non-goals

- Replacing acpx for CLI/dev use. Operators who want to drive `codex`/`claude`/`gemini` interactively keep `acpx` installed.
- Rules DSL / auto-approve engine. A `RulesResolver` ships as a built-in implementation but the expression surface — e.g. `Bash(git status:*)` — is out of scope for this spec; tracked separately.
- Persistent permission settings (project/user settings files). `allow_always` in this iteration is session-scoped only.
- Migrating every TUI screen. TUI cutover delivers the supervision dock (#193) in a follow-on; this spec exposes the resolver hook and keeps the existing log/session panel rendering working on the new runtime.
- Subprocess runtime, mock runtime, tmux runtime — unchanged. Only acpx is replaced.

## Decisions (locked during brainstorming)

| Question | Decision |
|---|---|
| Direct ACP vs upstream acpx patch | **Direct ACP.** Less net LOC (≈ 500 vs current 800 acpx wrapper + acpx upstream patch), removes per-turn cold start, native permission resolver, proper cancel. |
| Library | `@agentclientprotocol/sdk@^0.19.1` — same SDK acpx uses, zero transitive deps. |
| Provider launch | Three pinned adapters: `@zed-industries/codex-acp@^0.11.1`, `@agentclientprotocol/claude-agent-acp@^0.30.0`, `gemini-cli` (`gemini --acp`). Install detection ported from acpx's `agent-registry.ts:38-180` (~150 LOC). |
| Session model | One subprocess per `AgentSession`, not per turn. `startTurn` becomes a method on a reusable connection. |
| Resolver shape | `Client.requestPermission`-compatible: `(req: RequestPermissionRequest) => Promise<RequestPermissionResponse>`. No grove-native `PermissionDecision` type. |
| Default resolver | `DENY_ALL_RESOLVER` — selects the first `reject_*` option or returns `cancelled`. Runtime is safe by default; opt-in resolvers unlock tooling. |
| Feature flag | `GROVE_RUNTIME` env var. Default `acp` once parity tests pass; `acpx` remains available for one release for rollback. |
| AcpxRuntime fate | Kept until TUI E2E green on `AcpRuntime` for one release. Then deleted — not kept "for tmux compatibility", no long-lived legacy surface. |
| Session persistence / discovery | Grove's existing `SESSION_ID_PREFIX` + Nexus session store already carries this. `sessions list` against acpx disk store is not replicated; reattach works from grove's own records. |
| `fs/read_text_file`, `fs/write_text_file`, terminal methods | Implemented as pass-through (read/write the actual file, spawn a subprocess for terminal) with an **audit hook**. Full fs gating / terminal sandbox is a follow-on; this spec just wires the callbacks so the hook point exists. |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ grove process                                                │
│                                                              │
│   AcpRuntime (AgentRuntime impl)                             │
│     ├─ resolveLaunch(agent) → {bin, args}                    │
│     ├─ spawn(role, config)                                   │
│     │    └─ ChildProcess(bin, args) [persistent]             │
│     │         ├─ stdin  ──► ndJsonStream ──► ClientSide      │
│     │         └─ stdout ──► ndJsonStream ──► Connection      │
│     │                                               │       │
│     │                                               ▼       │
│     │                                      Client impl      │
│     │                                      ├─ sessionUpdate │
│     │                                      │   → Turn stream│
│     │                                      ├─ requestPerm.  │
│     │                                      │   → Resolver   │
│     │                                      ├─ readTextFile  │
│     │                                      │   → audit hook │
│     │                                      └─ writeTextFile │
│     │                                          → audit hook │
│     ├─ send(session, message)                                │
│     │    └─ connection.prompt({sessionId, prompt})           │
│     │         └─ returns AcpxTurn (same typed shape as #259) │
│     ├─ cancel(session) → connection.cancel(sessionId)        │
│     └─ close(session) → child.kill()                         │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                  PermissionResolver (pluggable)
                   ├─ DenyAllResolver (default)
                   ├─ TuiDockResolver (hooked by #193)
                   ├─ RulesResolver (built-in, minimal)
                   ├─ AuditingResolver (wraps another, JSONL log)
                   └─ ChainResolver (rules → tui → deny)
```

### Created

- `src/core/acp-runtime.ts` — `AcpRuntime implements AgentRuntime`. Subprocess lifecycle, per-session `ClientSideConnection`, turn plumbing returning `AcpxTurn`.
- `src/core/acp-launch.ts` — provider → bin/args table + install detection ported from acpx. Three entries: codex, claude, gemini.
- `src/core/permission-resolver.ts` — `PermissionResolver` interface, `DenyAllResolver`, `AllowAllResolver` (test-only), `AuditingResolver` wrapper, `ChainResolver`.
- `src/core/permission-rules.ts` — minimal `RulesResolver` with explicit session-scoped rules; no pattern DSL in v1 (exact match on `toolCall.kind` + a deny-list on `toolCall.title`).
- `src/core/acp-client.ts` — glue factory that wires a `Client` impl (permission routing, sessionUpdate fan-out, fs/terminal audit callbacks) to a grove-side turn stream.
- Tests: `acp-runtime.test.ts`, `acp-runtime.integration.test.ts`, `acp-launch.test.ts`, `permission-resolver.test.ts`, `permission-rules.test.ts`.

### Modified

- `src/core/index.ts` — export `AcpRuntime`, `PermissionResolver` types.
- `src/core/workspace-bootstrap.ts` / wherever runtime selection lives — read `GROVE_RUNTIME` env, default `acp`, return `AcpRuntime` or `AcpxRuntime`. Preserve `MockRuntime` / `SubprocessRuntime` / `TmuxRuntime` as-is.
- `src/core/agent-runtime.ts` — if needed, extend `AgentRuntime` interface with optional `setPermissionResolver(r)` method. Existing runtimes get a no-op default.
- `src/tui/app.tsx` or equivalent bootstrapper — build the resolver chain (initially `DenyAllResolver` in headless runs, `TuiDockResolver` when TUI is attached), pass to `AcpRuntime` constructor.
- `package.json` — add `@agentclientprotocol/sdk`, `@zed-industries/codex-acp`, `@agentclientprotocol/claude-agent-acp` as dependencies. `gemini-cli` remains an external install check like `acpx` today.

### Unchanged

- `src/acp/` typed stream primitives. `AcpxTurn` contract preserved.
- `src/tui/data/*` — `AcpMessageSink`, `SessionStore`, `session-log-projector` continue to consume the same `Message` stream shape.
- `publishTurnToNexus` and the Nexus SSE producer.

## Types

```ts
// src/core/permission-resolver.ts
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

export interface PermissionResolver {
  resolve(req: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}

export const DENY_ALL_RESOLVER: PermissionResolver = {
  async resolve(req) {
    const reject = req.options.find(
      (o) => o.kind === "reject_once" || o.kind === "reject_always",
    );
    return reject
      ? { outcome: { outcome: "selected", optionId: reject.optionId } }
      : { outcome: { outcome: "cancelled" } };
  },
};

export class AuditingResolver implements PermissionResolver {
  constructor(
    private readonly inner: PermissionResolver,
    private readonly logPath: string,
  ) {}
  async resolve(req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const response = await this.inner.resolve(req);
    // append JSONL: {ts, sessionId, toolCall, options, response}
    return response;
  }
}

export class ChainResolver implements PermissionResolver {
  constructor(private readonly resolvers: PermissionResolver[]) {}
  async resolve(req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    for (const r of this.resolvers) {
      const out = await r.resolve(req);
      // "cancelled" signals abstention to the next resolver; "selected" terminates.
      if (out.outcome.outcome === "selected") return out;
    }
    return DENY_ALL_RESOLVER.resolve(req);
  }
}
```

```ts
// src/core/acp-runtime.ts (sketch)
export class AcpRuntime implements AgentRuntime {
  constructor(options?: {
    permissionResolver?: PermissionResolver;
    fsAuditor?: (op: "read" | "write", path: string, sessionId: string) => void;
    launchOverride?: LaunchOverride; // test injection
    logDir?: string;
  }) {}

  setPermissionResolver(resolver: PermissionResolver): void;

  async spawn(role: string, config: AgentConfig): Promise<AgentSession>;
  async send(session: AgentSession, message: string): Promise<AcpxTurn>;
  async cancel(session: AgentSession): Promise<void>;
  async close(session: AgentSession): Promise<void>;
  async listSessions(): Promise<readonly AgentSession[]>;
  onIdle(session: AgentSession, cb: () => void): void;
}
```

## Stream fidelity

Per spike: agent `session/update` variants — `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `usage_update`. `AcpRuntime` converts each into the existing `Message` union (`src/acp/types.ts`):

| ACP update | grove `Message.kind` |
|---|---|
| `agent_message_chunk` | `text` with `chunk: true` |
| `agent_thought_chunk` | `thinking` with `chunk: true` |
| `tool_call`, `tool_call_update` | `tool_call` |
| `usage_update` | `token_usage` |
| `plan`, `available_commands_update`, `*_mode_update`, `*_config_option_update`, `session_info_update` | `raw` (parser escape hatch, already supported) |
| (inbound `requestPermission`) | `permission_request` *and* resolver invocation (two audiences: the stream observers for UI plus the resolver for the decision) |

Turn termination: `connection.prompt(...)` resolves with `{ stopReason }`. `AcpRuntime` emits the `Result` frame through the same `AcpxTurnImpl` path already used by `AcpxRuntime`. Downstream consumers (`AcpMessageSink`, `SessionStore`, Nexus) see identical events.

## Cancel

- `AcpRuntime.cancel(session)` calls `connection.cancel(sessionId)`.
- Agent finishes emitting any pending `session/update`s, then resolves the outstanding `session/prompt` with `stopReason: "cancelled"`.
- `AcpxTurnImpl.cancel()` no longer needs the SIGINT fallback; kept as a belt-and-braces for a hung child.

## fs / terminal interception

`Client.readTextFile` and `Client.writeTextFile` are implemented as true pass-throughs:
1. Record `{op, path, sessionId, ts}` via `fsAuditor` if provided.
2. Perform the actual read/write against disk (ACP spec requires real fs access to answer).

A richer sandbox (rejecting writes outside the session cwd, chrooting reads) is **out of scope** — this spec only guarantees the audit hook point exists. Terminal methods (`terminal/create` etc.) are handled similarly: spawn the requested shell, audit the command. Agent binaries typically handle their own shells via `tool_call execute`, so terminal methods are rarely exercised in practice for codex/claude/gemini — we implement the minimum that satisfies the Client trait.

## Error handling

- **Agent binary missing** — `resolveLaunch` throws with the exact npm install command (`npm install -g @zed-industries/codex-acp@^0.11.1`) before spawn.
- **Handshake failure** — `initialize` or `session/new` errors propagate as spawn failures; `AgentSession` never transitions to `running`.
- **Connection drop mid-turn** — `session/prompt` rejects; `AcpxTurn.result` resolves with `{stopReason: "error", error: { code: "connection_closed", ... }}`.
- **Resolver throws** — wrapped in `try/catch` at `requestPermission` boundary. Decision becomes `cancelled` with error logged. Agent sees a regular cancelled outcome; grove logs the stack.
- **`session/load` unsupported** — not used in this spec (we create a fresh session per spawn); reattach across grove restarts is covered by grove's own session records, not ACP's `loadSession`.

## Testing

**Unit (fast, no subprocess):**
- `acp-runtime.test.ts` — uses the SDK's in-memory `ClientSideConnection` paired with an `AgentSideConnection` test double. Exercise spawn / send / cancel / close, verify typed stream shape, verify resolver called with real `RequestPermissionRequest` fixtures.
- `permission-resolver.test.ts` — `DenyAllResolver`, `ChainResolver` abstention-to-next, `AuditingResolver` writes JSONL, `RulesResolver` exact-match allow.
- `acp-launch.test.ts` — install detection finds pinned packages in `node_modules/.bin`, returns correct launch spec; missing package throws with install hint.

**Integration (real subprocess, requires adapter installed):**
- `acp-runtime.integration.test.ts` — spawn real `codex-acp`, real prompt, assert typed stream, assert real cancel, assert permission request surfaces to resolver.
- Skipped when adapters unavailable (mirrors current `AcpxRuntime.integration.test.ts`).

**E2E:**
- `tests/tui/acp-worktree-e2e.ts` — retarget against `AcpRuntime`. Existing assertions should pass unchanged because the typed stream shape is preserved.
- New E2E: operator permission dock approves / denies a write, verify agent continues / aborts.

**Parity gate before flipping default:**
- Run the existing `AcpxRuntime` integration tests *and* `AcpRuntime` integration tests on the same golden fixtures. Compare emitted `Message` sequences modulo timing noise; any divergence blocks the default switch.

## Rollout

1. Land `AcpRuntime` behind `GROVE_RUNTIME=acp` (opt-in). `acpx` remains default.
2. Parity tests green on codex, claude, gemini.
3. TUI cutover: default resolver becomes `TuiDockResolver` when a TUI is attached (#193 consumes this surface).
4. Flip `GROVE_RUNTIME` default to `acp`. `acpx` path remains available for one release.
5. Delete `AcpxRuntime` + its tests + `--approve-all` scaffolding. Update `feedback_acpx_not_tmux` memory (`Use ACP direct, not acpx subprocess`).

## Open questions

- **`session/load` need.** Today no — we create fresh sessions per spawn. If the TUI ever wants "resume the agent that crashed", we'll need to opt into `loadSession` with an adapter-capability probe. Keep out of v1.
- **Multi-session per subprocess.** ACP allows multiple `session/new` calls per agent connection. Grove currently spawns one process per session. Sharing a single process across multiple role sessions would cut memory but complicate lifetime. Defer until measured.
- **Flow-file parity.** acpx supports flow files (multi-step ACP workflows). Grove does not use this. Confirm with stakeholders no team depends on it before deleting `AcpxRuntime`.
