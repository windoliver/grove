# Owner References and Finalizers for Cascade Session Cleanup - Design

- **Issue**: [#271](https://github.com/windoliver/grove/issues/271)
- **Date**: 2026-05-07
- **Status**: Approved for full issue scope

## Goal

Add Kubernetes-style owner references and finalizers so ending or deleting a
session deterministically releases owned claims, owned contribution links, and
runtime cleanup obligations before the session row is removed.

## Non-goals

- Do not change the canonical contribution manifest or contribution CID inputs.
  Contribution ownership is store metadata, not contribution wire format.
- Do not introduce a generic informer framework.
- Do not replace existing claim lease expiry or periodic cleanup. Finalizers are
  the synchronous session-deletion path; sweeps remain a recovery mechanism.

## Chosen Approach

Implement session deletion as the lifecycle orchestration point. A delete call
marks the session with `deletionTimestamp`, runs known finalizer controllers
synchronously, removes finalizers as each cleanup succeeds, and deletes the row
when no finalizers remain. Owned resources carry an `ownerRef` with the parent
kind, id, and uid. Force delete bypasses finalizer waits, emits an audit record,
and cascades best-effort cleanup.

This is preferred over a reconciler-only approach because operators need an
immediate answer to "what is blocking this delete?" and because the issue asks
for deterministic cleanup when a session ends, not eventual cleanup by sweep.

## Data Model

Add shared lifecycle metadata in `src/core/lifecycle-metadata.ts`:

```ts
export type OwnerKind = "session" | "claim";

export interface OwnerRef {
  readonly kind: OwnerKind;
  readonly id: string;
  readonly uid: string;
}

export type Finalizer =
  | "grove.io/release-slots"
  | "grove.io/drain-contribs"
  | "grove.io/close-runtime";

export interface DeletionAuditEvent {
  readonly at: string;
  readonly actor: string;
  readonly force: boolean;
  readonly warning: string;
}
```

Extend `Session` with:

```ts
readonly uid: string;
readonly finalizers: readonly Finalizer[];
readonly deletionTimestamp?: string | undefined;
readonly deletionAudit?: readonly DeletionAuditEvent[] | undefined;
```

Extend `Claim` with:

```ts
readonly ownerRef?: OwnerRef | undefined;
readonly finalizers?: readonly Finalizer[] | undefined;
readonly deletionTimestamp?: string | undefined;
```

Contribution ownership is represented by `session_contributions.owner_ref_json`
in SQLite and by session contribution sidecar metadata in Nexus. Entity
projection exposes `metadata.ownerRefs` for claims and contribution entities,
but the contribution manifest itself remains unchanged.

Legacy rows without `uid` receive a generated UID during SQLite migration. JSON
stores synthesize a UID for read-only compatibility, then persist it before any
mutation that needs ownership checks, including delete. Legacy rows without
finalizers are treated as having the current default session finalizers at delete
time, not at read time.

## Store API

Extend `SessionStore` with deletion methods:

```ts
export interface SessionDeleteOptions {
  readonly force?: boolean | undefined;
  readonly actor?: string | undefined;
}

export interface SessionDeleteBlocker {
  readonly finalizer: Finalizer;
  readonly message: string;
}

export interface SessionDeleteResult {
  readonly sessionId: string;
  readonly deleted: boolean;
  readonly forced: boolean;
  readonly blockers: readonly SessionDeleteBlocker[];
  readonly warning?: string | undefined;
}

deleteSession(id: string, options?: SessionDeleteOptions): Promise<SessionDeleteResult>;
listSessionDeleteBlockers(id: string): Promise<readonly SessionDeleteBlocker[]>;
```

`archiveSession()` keeps its existing meaning. `deleteSession()` is the new hard
delete path. `updateSession()` may set `deletionTimestamp` only through
`deleteSession()` so lifecycle invariants stay in one place.

Extend `ClaimStore` with owner-aware cleanup helpers:

```ts
listClaims(query?: ClaimQuery & { readonly ownerRef?: OwnerRef }): Promise<readonly Claim[]>;
releaseOwnedBy(ownerRef: OwnerRef): Promise<number>;
deleteTerminalOwnedBy(ownerRef: OwnerRef): Promise<number>;
```

Backends that cannot efficiently query owner refs may scan claim records in this
first implementation; correctness takes precedence over index efficiency.

## Finalizers

Session creation stores these default finalizers:

```text
grove.io/release-slots
grove.io/drain-contribs
grove.io/close-runtime
```

The controllers are intentionally small and backend-local:

- `release-slots`: release active claims owned by the session and delete
  terminal owned claims once released.
- `drain-contribs`: ensure all linked session contributions are durable, then
  delete the session contribution ownership links. It does not delete immutable
  contribution rows, because contributions can outlive a session and may be
  adopted by other work.
- `close-runtime`: call an optional runtime cleanup hook when the delete request
  is served by a process that owns the runtime. If no runtime hook is configured,
  the finalizer is removed and the result records no blocker. Runtime cleanup for
  remote/dead processes is covered by existing runtime close paths and force
  delete.

If a finalizer cannot complete, it stays on the session and
`deleteSession()` returns `deleted: false` with blockers. A later delete retry
continues from the remaining finalizers.

## Delete Flow

Normal delete:

1. Read the session. Missing session returns not found at API/MCP boundaries.
2. If `deletionTimestamp` is absent, write it and ensure default finalizers are
   present.
3. Run finalizers in stable order: release slots, drain contributions, close
   runtime.
4. Remove each finalizer only after its cleanup succeeds.
5. If finalizers remain, return blockers and leave the session visible as
   terminating.
6. If finalizers are empty, delete the session row/record and owned session
   contribution links.

Force delete:

1. Mark `deletionTimestamp` if needed.
2. Append a `DeletionAuditEvent` with actor, timestamp, `force: true`, and a
   warning string.
3. Best-effort release/delete owned claims and session contribution links.
4. Delete the session record even when finalizers would otherwise block.
5. Return `forced: true` and the warning to the caller.

## API and Tools

HTTP:

- `DELETE /api/sessions/:id`
- `DELETE /api/sessions/:id?force=true`
- `GET /api/sessions/:id/delete-blockers`

Delete response:

```json
{
  "sessionId": "session-id",
  "deleted": false,
  "forced": false,
  "blockers": [
    {
      "finalizer": "grove.io/release-slots",
      "message": "2 active claim(s) still owned by this session"
    }
  ]
}
```

MCP:

- Add `grove_delete_session` with `sessionId`, optional `force`, and optional
  `actor`.
- Add `grove_session_delete_blockers` for operator inspection.

CLI:

- Add `grove session delete <session-id> [--force]`.
- On force, print the same warning returned by the store.

## SQLite Storage

Migration adds:

- `sessions.uid TEXT`
- `sessions.finalizers_json TEXT NOT NULL DEFAULT '[]'`
- `sessions.deletion_timestamp TEXT`
- `sessions.deletion_audit_json TEXT NOT NULL DEFAULT '[]'`
- `claims.owner_ref_json TEXT`
- `claims.finalizers_json TEXT NOT NULL DEFAULT '[]'`
- `claims.deletion_timestamp TEXT`
- `session_contributions.owner_ref_json TEXT`

Indexes:

- `idx_sessions_deletion_timestamp`
- `idx_claims_owner_ref_kind_id_uid` via generated JSON extraction is deferred
  unless SQLite JSON expression indexes are already used elsewhere. The initial
  implementation may scan by owner JSON because session-owned claim counts are
  bounded by normal session concurrency.

`SqliteGoalSessionStore.deleteSession()` runs in an immediate transaction with
the shared `SqliteClaimStore` cleanup SQL when both stores share the same
database. The local factory wires the two stores together so session deletion can
release claims atomically.

## Nexus Storage

Sessions remain JSON records under:

```text
/zones/{zoneId}/sessions/{id}.json
```

Contribution links move from a bare array sidecar to a versioned object:

```json
{
  "version": 2,
  "items": [
    {
      "cid": "blake3:...",
      "ownerRef": { "kind": "session", "id": "id", "uid": "uid" },
      "addedAt": "2026-05-07T00:00:00.000Z"
    }
  ]
}
```

The reader accepts legacy array sidecars. The writer always writes version 2.
`NexusSessionStore.deleteSession()` uses normal JSON record updates plus claim
store owner queries. It is not globally atomic across files, so each step is
idempotent and retry-safe.

## Entity Projection

`claimToEntity()` copies `ownerRef` into `metadata.ownerRefs`. Terminating
claims expose a `Terminating` condition when `deletionTimestamp` is set.

`agentSessionToEntity()` and session API responses expose:

- `uid`
- `finalizers`
- `deletionTimestamp`

`contributionToEntity()` accepts an optional owner ref parameter for store
projections. Existing direct contribution projections keep no owner ref.

## Error Handling

- Missing session: HTTP 404, MCP operation error `NOT_FOUND`.
- Normal delete blocked: HTTP 409 with blocker details; MCP returns an
  operation result with `deleted: false` and blockers.
- Force delete: HTTP 200 with `forced: true` and warning.
- Finalizer exception: keep the finalizer, return a blocker message with the
  finalizer name, and do not delete the session.
- Partial Nexus cleanup: all writes are idempotent, so retrying delete resumes
  from persisted state.

## Compatibility

Existing session creation, listing, archiving, and contribution submission keep
working. Default list calls include terminating sessions unless they are
archived or fully deleted, so operators can inspect blockers.

Existing clients that read `session.contributions.json` as a raw array are not
part of the public API; server and Nexus provider code will accept both shapes.
No existing contribution CID changes because contribution manifests are
untouched.

## Testing

- Core model/entity tests for owner refs, finalizers, deletion timestamps, and
  terminating conditions.
- Session store conformance tests for normal delete, blocked delete, force
  delete, idempotent retry, and missing session behavior.
- SQLite tests for migrations, transactional claim release, session contribution
  link deletion, and legacy rows.
- Nexus tests for versioned contribution sidecar reads/writes, idempotent delete
  retry, and force warning/audit persistence.
- HTTP route tests for delete, force delete, blockers endpoint, and response
  codes.
- MCP tool tests for delete and blocker inspection.
- CLI tests for `grove session delete`, including `--force` warning output.

## Implementation Constraints

- The `close-runtime` finalizer should be wired through an optional dependency
  rather than hard-coding `SessionOrchestrator`, because most API delete calls
  operate against persisted sessions and may not own a live runtime.
- Claim ownership should be stamped when claims are created in a scoped session.
  Existing flows already carry `GROVE_SESSION_ID`; the implementation should
  resolve the session UID from the session store where available.
- Force delete must not swallow cleanup errors silently. It should return the
  warning plus any best-effort cleanup errors in a diagnostic field while still
  removing the session record.
