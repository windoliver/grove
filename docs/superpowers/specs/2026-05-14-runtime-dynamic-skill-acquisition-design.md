# Runtime Dynamic Skill Acquisition - Design

- **Date:** 2026-05-14
- **Issue:** [#328](https://github.com/windoliver/grove/issues/328)
- **Parent:** [#202](https://github.com/windoliver/grove/issues/202)
- **Builds on:** [#262](https://github.com/windoliver/grove/issues/262), [#326](https://github.com/windoliver/grove/issues/326), [#327](https://github.com/windoliver/grove/issues/327)
- **Status:** Approved design; awaiting implementation plan

## Summary

Grove can inject role-declared native skills at agent bootstrap time. After an
agent starts, its skill set is effectively frozen: adding a skill requires
killing and respawning the agent. This design adds a narrow runtime acquisition
path so an agent can request an allowlisted skill through Grove's stdio MCP
surface and receive usable skill instructions immediately.

The first implementation installs skill directories into the live workspace,
returns bounded `SKILL.md` content in the MCP response, and persists the
successful acquisition into the session's effective role skills. Provider
native live-reload remains best-effort because Claude/Codex skill discovery is
not a stable Grove-owned contract.

## Goals

- Let an active stdio MCP agent request a skill without restarting the whole
  Grove session.
- Keep runtime acquisition disabled unless an operator explicitly configures a
  per-role allowlist.
- Reuse existing local/Nexus skill resolution and native injection paths.
- Preserve acquired skills across reattach/restart by updating session state.
- Return enough skill content for immediate use when provider live reload is
  unavailable.
- Keep HTTP MCP mutation out of scope until it has a per-agent binding model.

## Non-Goals

- A general plugin/package registry.
- Runtime acquisition over shared HTTP MCP.
- Human approval queues in the first implementation.
- Capability tokens in the first implementation.
- Guaranteed provider-native hot reload for Claude, Codex, or future
  providers.
- Catalog publishing workflows; those stay under the Nexus skill catalog work.
- Runtime removal of skills from a live workspace.

## Current State

Bootstrap-time skill injection already exists:

- `src/core/skill-injector.ts` resolves skill directories from a workspace
  override root and bundled catalog, then copies them to
  `.claude/skills/{name}/` and `.codex/skills/{name}/`.
- `src/core/workspace-bootstrap.ts`, `src/core/session-orchestrator.ts`, and
  `src/tui/spawn-manager.ts` pass role-level `skills` to injection.
- `src/nexus/nexus-skill-catalog.ts` resolves signed Nexus-hosted skills,
  verifies catalog signatures and BLAKE3 bundle hashes, materializes a
  verified local root, and falls back according to policy.
- `src/core/session-skill-overrides.ts` treats launch-time skill edits as an
  effective topology rewrite before session creation.
- `src/mcp/serve.ts` runs stdio MCP from the agent workspace, binds
  `GROVE_AGENT_ROLE` from env or `.grove-role`, and receives
  `GROVE_SESSION_ID` when launched by Grove.

The missing piece is a post-bootstrap tool and service that can safely mutate
the current workspace's provider-native skill directories.

## Chosen Approach

Add a stdio-only MCP tool, `grove_request_skill`, backed by a core
`runtime-skill-acquisition` service.

The tool checks the caller role against a per-role allowlist in
`.grove/grove.json`, resolves the requested skill through the same mode-aware
resolution chain as bootstrap, injects the skill into the current MCP process
cwd, persists the skill onto the session's effective role skills, and returns
bounded `SKILL.md` content as immediate context.

This approach is intentionally smaller than approval queues or provider-native
reload hooks. It gives agents a useful runtime path now while preserving clear
extension points for stricter authorization and live reload later.

## Configuration

Extend `.grove/grove.json` with an optional `runtimeSkills` block:

```json
{
  "runtimeSkills": {
    "mode": "role-allowlist",
    "roles": {
      "coder": ["grove", "review"],
      "reviewer": ["grove"]
    },
    "returnSkillMdMaxBytes": 65536
  }
}
```

Rules:

- Omitted `runtimeSkills` disables runtime acquisition.
- `mode` has one value in this spec: `role-allowlist`.
- `roles` maps exact topology role names to exact skill names.
- Missing role, missing skill, and empty allowlist all deny the request.
- `returnSkillMdMaxBytes` defaults to `65536` and is capped at `262144`.
- Skill names use the same safe-name validation as Nexus catalog requests:
  non-empty, no `/`, no `\`, no NUL, not `.` or `..`.

The config is local trust policy. Nexus remains only a content source; it does
not grant runtime acquisition permission.

## MCP Tool Contract

Register `grove_request_skill` whenever the MCP preset transport is `stdio`.
In stdio, the tool remains registered even when `runtimeSkills` is absent; that
case returns `NOT_CONFIGURED` so agents get an explicit explanation. HTTP MCP
omits the tool because the current HTTP transport multiplexes clients through a
shared process and does not provide a trusted per-agent cwd/role binding for
filesystem mutation.

Input:

```ts
{
  skillName: string;
  reason?: string | undefined;
}
```

The tool ignores any model-supplied agent identity. The trusted caller context
is derived from:

- `process.env.GROVE_AGENT_ROLE` or the workspace `.grove-role` fallback already
  used by `src/mcp/serve.ts`;
- `process.env.GROVE_AGENT_ID`, when present;
- `process.env.GROVE_SESSION_ID`;
- `process.cwd()` as the live workspace path.

Successful response:

```json
{
  "skillName": "review",
  "status": "installed",
  "source": "nexus",
  "sessionPersisted": true,
  "providerReload": {
    "status": "context-returned",
    "message": "Provider live reload is not guaranteed; use returned skill content immediately."
  },
  "installedTargets": [
    ".claude/skills/review",
    ".codex/skills/review"
  ],
  "skill": {
    "name": "review",
    "skillMd": "...",
    "truncated": false
  },
  "warnings": []
}
```

`status` values:

- `installed` - files were installed in this call.
- `already_installed` - the target already had a valid skill directory and the
  request was still authorized.

`source` values mirror the existing resolver: `nexus`, `cache`, `local`,
`override`, or `bundled`.

`providerReload.status` values:

- `context-returned` - MVP behavior. Skill content is returned for immediate
  use; native files are present for future provider discovery.
- `reloaded` - reserved for a future provider-specific hook that has been
  implemented and tested.
- `restart-required` - reserved for providers that can detect no live reload
  path and do not accept returned context.

## Core Service

Add `src/core/runtime-skill-acquisition.ts` with a small service boundary:

```ts
export interface RuntimeSkillCaller {
  readonly role: string;
  readonly agentId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly workspacePath: string;
}

export interface RuntimeSkillAcquisitionOptions {
  readonly skillName: string;
  readonly reason?: string | undefined;
  readonly caller: RuntimeSkillCaller;
}

export interface RuntimeSkillAcquisitionService {
  requestSkill(
    options: RuntimeSkillAcquisitionOptions,
  ): Promise<RuntimeSkillAcquisitionResult>;
}
```

The service depends on explicit interfaces for:

- reading Grove config;
- resolving a skill root through Nexus/cache/local catalogs;
- injecting skills with `injectSkills()`;
- reading bounded `SKILL.md` content from the installed target;
- appending a role skill to session state when `sessionId` is present;
- emitting optional runtime-skill write notifications.

The service should not import MCP types. MCP owns input parsing and converts
service errors to MCP tool results.

## Data Flow

1. Agent calls `grove_request_skill({ skillName, reason })`.
2. MCP handler builds trusted caller context from env and process cwd.
3. Service validates the skill name.
4. Service loads `.grove/grove.json` and checks
   `runtimeSkills.roles[caller.role]`.
5. Service resolves the skill:
   - Nexus signed catalog, verified cache, local fallbacks in Nexus mode;
   - workspace override, then bundled catalog in local mode.
6. Service injects the skill into `caller.workspacePath` with `injectSkills()`.
7. Service reads bounded `SKILL.md` from the installed Codex or Claude target.
8. Service appends the skill to the session's effective topology role skills
   when `caller.sessionId` is available.
9. Service returns installed targets, source, warnings, persistence status, and
   skill content.

## Session Persistence

Runtime acquisition is the first controlled post-creation mutation of
`Session.topology`. That mutation is intentionally narrow: append one
authorized skill name to one existing role's `skills` list.

Add a dedicated store capability instead of widening generic `updateSession`:

```ts
export interface RuntimeSkillSessionStore {
  appendSessionRoleSkill(
    sessionId: string,
    roleName: string,
    skillName: string,
  ): Promise<"appended" | "already_present" | "session_missing" | "role_missing">;
}
```

Implementations:

- SQLite runs the read/modify/write in an immediate transaction and updates
  `topology_json`.
- Nexus reads the session record with ETag and retries on CAS conflict.
- In-memory store updates the cloned topology for tests.

Persistence rules:

- Preserve role order and all non-skill topology fields.
- Deduplicate skills while preserving existing order.
- Append runtime-acquired skills after launch-time skills.
- If the session is missing or the role is missing, report
  `SESSION_PERSIST_FAILED` after successful workspace injection.
- Repeated requests are idempotent and should repair missing persistence if the
  workspace was already installed.

The `Session.topology` comment should be updated from absolute immutability to
effective-session immutability with this explicit exception.

## Provider Reload Story

The MVP does not claim that Claude or Codex will discover a new skill directory
inside the already-running model/tool host.

Reliable behavior:

- skill files are installed in the live workspace now;
- `SKILL.md` content is returned in the MCP response now;
- future turns, reattach, or restart can discover native skill directories if
  the provider scans them.

Add a small extension point for future reload hooks:

```ts
export interface ProviderSkillReloader {
  reloadSkill(skillName: string, workspacePath: string): Promise<ProviderReloadResult>;
}
```

No provider-specific hook is required for this issue. The default reloader
returns `context-returned`.

## Error Handling

Use structured service errors and map them to MCP errors:

| Code | Condition |
|---|---|
| `NOT_CONFIGURED` | `runtimeSkills` is absent or disabled |
| `NOT_AUTHORIZED` | role is not allowlisted for `skillName` |
| `INVALID_SKILL_NAME` | unsafe or malformed skill name |
| `WORKSPACE_UNAVAILABLE` | MCP cwd is missing or cannot be used as a workspace |
| `NOT_FOUND` | requested skill cannot be resolved from allowed sources |
| `CATALOG_UNAVAILABLE` | Nexus catalog/cache path fails under configured policy |
| `INTEGRITY_ERROR` | signature, hash, or bundle validation fails |
| `INSTALL_FAILED` | filesystem copy/chmod/read fails |
| `SESSION_PERSIST_FAILED` | workspace mutation succeeded but session update failed |

If injection succeeds and persistence fails, return an error that includes:

- `workspaceInstalled: true`;
- installed target paths;
- a retry-safe message telling the caller to call `grove_request_skill` again.

Warnings may include skill name, attempted source, fallback source, and
sanitized reason. They must never include Nexus API keys, bearer tokens, local
credential file contents, or credentialed URLs.

## Security Notes

- Runtime acquisition is disabled by default.
- Stdio MCP is required for installation because it has a per-agent process
  binding and stable cwd.
- Caller role is trusted only from process binding, not tool args.
- The allowlist is local Grove config, not Nexus catalog metadata.
- Nexus content still requires signed index verification and BLAKE3 bundle
  verification.
- The service validates all skill names before path construction.
- The final injected files remain read-only (`0o444`) through the existing
  injector behavior.
- The tool should not expose a list of denied skills. A denial reveals only the
  requested skill and caller role.

## Public Surfaces

New:

- `src/core/runtime-skill-acquisition.ts`
- `src/mcp/tools/runtime-skills.ts`

Modified:

- `src/core/config.ts` - parse and serialize `runtimeSkills`.
- `src/core/session.ts` - add `RuntimeSkillSessionStore` capability or an
  adjacent exported interface; update the topology comment.
- `src/local/sqlite-goal-session-store.ts` - implement append capability.
- `src/nexus/nexus-session-store.ts` - implement append capability with ETag
  conflict handling.
- `src/mcp/deps.ts` - add an optional `RuntimeSkillAcquisitionService`
  dependency.
- `src/mcp/server.ts` - register runtime skill tools only for stdio transport.
- `src/mcp/serve.ts` - wire config, catalog resolver, session store, and
  workspace cwd into the runtime service.
- `src/mcp/serve-http.ts` - explicitly omit mutation tools on HTTP transport.

No CLI or TUI surface is required for the MVP beyond configuration and any
natural session refresh after persistence.

## Testing

Core unit tests:

- config parsing accepts valid `runtimeSkills` and rejects unknown modes,
  unsafe skill names, empty role names, and oversized return limits.
- unauthorized role/skill returns `NOT_AUTHORIZED`.
- omitted config returns `NOT_CONFIGURED`.
- unsafe skill names are rejected before any resolver call.
- idempotent request returns `already_installed`.
- bounded `SKILL.md` response truncates predictably.
- injection success plus persistence failure returns retry-safe
  `SESSION_PERSIST_FAILED`.

Session store tests:

- append role skill updates topology for SQLite, Nexus, and in-memory stores.
- append is idempotent.
- missing session and missing role are reported distinctly.
- Nexus implementation retries or cleanly reports CAS conflicts.

MCP tests:

- stdio preset registers `grove_request_skill`.
- HTTP preset omits `grove_request_skill`.
- handler binds role/session/workspace from env/cwd, not args.
- successful response includes installed targets and bounded skill content.

Integration tests:

- local catalog skill installs into `.claude` and `.codex` paths.
- Nexus signed catalog resolution is reused in Nexus mode.
- verified cache fallback is reused when Nexus is unavailable.
- session restart/bootstrap sees the persisted skill in effective topology.

## Migration

Existing Grove sessions and configs continue unchanged. In stdio MCP, the new
tool returns `NOT_CONFIGURED` until `runtimeSkills` is present. HTTP MCP does
not register the mutation tool.

Operators opt in by adding `runtimeSkills` to `.grove/grove.json`. Existing
bootstrap `skills` behavior remains the base skill set; runtime-acquired skills
append to that base for the current session only.

## Future Extensions

- Operator approval queue for sensitive skills.
- Capability tokens for delegated or federated authorization.
- HTTP MCP support once per-client role/workspace binding exists.
- Provider-specific live reload hooks.
- Optional TUI display of runtime skill acquisition history.
- Runtime skill removal with explicit provider and session-state semantics.

## Open Questions

None remaining for this issue scope. The approved defaults are:

- role allowlist with automatic install;
- persistence into session effective role skills;
- returned `SKILL.md` content as the reliable live-reload fallback;
- provider-specific reload hooks deferred behind an extension interface.
