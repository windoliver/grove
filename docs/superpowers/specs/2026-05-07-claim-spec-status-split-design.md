# Claim Spec/Status Split Design

## Summary

Issue #270 splits claim ownership into user-editable desired state and controller-owned observed state. Grove will store claims as `claim_spec` plus `claim_status`, expose explicit spec and status subresource routes, and keep the existing flat `Claim` API compatible for CLI, TUI, MCP, bounty, and legacy HTTP consumers.

This is a storage and write-surface change, not a full claim lifecycle rewrite. The reconciler work in issue #268 can build on the new status-only write path.

## Goals

- Separate user-owned claim fields from controller-owned status fields at the store boundary.
- Add spec-only and status-only HTTP routes:
  - `PUT /api/claims/:id`
  - `PATCH /api/claims/:id/status`
  - `GET /api/claims/:id`
- Require a controller token for status writes while preserving namespace bearer auth for all `/api/*` routes.
- Keep existing flat claim reads and legacy mutation methods compatible.
- Migrate existing SQLite `claims` rows into split tables without data loss.
- Ensure controllers never mutate spec and user writes cannot clobber status.

## Non-Goals

- Do not replace the whole claim lifecycle with the issue #268 reconciler loop.
- Do not remove existing `POST /api/claims`, `PATCH /api/claims/:id`, or `GET /api/claims` behavior.
- Do not change the external flat `Claim` shape returned by existing legacy routes.
- Do not add CRD machinery, code generation, finalizers, or owner refs.
- Do not redesign Nexus VFS storage beyond what is needed to implement the new `ClaimStore` methods. Nexus must preserve logical spec/status write ownership, but SQLite is the backend that gets the physical `claim_spec` and `claim_status` tables from this issue.

## Current State

The local SQLite backend stores one `claims` row containing desired state and observed state together:

- Desired state: `target_ref`, `agent_json`, `intent_summary`, `context_json`, lease duration implied by timestamps.
- Observed state: `status`, `heartbeat_at`, `lease_expires_at`, `attempt_count`, `revision`.

The Entity adapter already projects claims into `spec` and `status`, but this projection happens after reads. Store writers can still update mixed fields in one row.

The HTTP server has namespace bearer-token auth only. There is no existing controller-token role, so #270 needs a narrow controller-auth check for the status subresource.

## Approach

Use a compatibility-first split:

1. Add explicit core DTOs for `ClaimSpec`, `ClaimStatusRecord`, and `ClaimView`.
2. Extend `ClaimStore` with spec/status methods.
3. Implement the split physically in SQLite with `claim_spec` and `claim_status`.
4. Update in-memory and Nexus claim stores to satisfy the same logical spec/status method contract.
5. Reimplement existing flat `ClaimStore` methods as adapters over split DTOs.
6. Add HTTP routes for spec/status writes and merged reads.
7. Keep legacy routes backed by the same split storage or adapter contract.

This gives #270 real isolation without forcing every caller to migrate immediately.

## Data Model

### ClaimSpec

`ClaimSpec` is the user-editable desired state. It contains the issue #270 fields plus compatibility fields needed to preserve the current flat claim API.

```ts
export interface ClaimSpec {
  readonly id: string;
  readonly roleName?: string | undefined;
  readonly platform?: string | undefined;
  readonly blueprint?: string | undefined;
  readonly assignee?: AgentIdentity | undefined;
  readonly leaseDeadlineSec?: number | undefined;
  readonly priority?: number | undefined;
  readonly maxIterations?: number | undefined;
  readonly generation: number;

  // Compatibility fields for existing Claim consumers.
  readonly targetRef: string;
  readonly agent: AgentIdentity;
  readonly intentSummary: string;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly createdAt: string;
}
```

Spec writes increment `generation` monotonically. Clients cannot set `generation` directly through HTTP; the store controls it.

Legacy claim writes derive missing spec fields:

- `roleName` from `agent.role` when present.
- `platform` from `agent.platform` when present.
- `assignee` from `agent`.
- `leaseDeadlineSec` from `leaseExpiresAt - createdAt`.

### ClaimStatusRecord

`ClaimStatusRecord` is controller-owned observed state.

```ts
export interface ClaimStatusRecord {
  readonly id: string;
  readonly phase: ClaimStatus;
  readonly observedGeneration: number;
  readonly agentSessionId?: string | undefined;
  readonly lastHeartbeatAt: string;
  readonly leaseExpiresAt: string;
  readonly currentContributionCid?: string | undefined;
  readonly conditions: readonly Condition[];
  readonly lastTransitionAt: string;
  readonly attemptCount: number;
  readonly revision: number;
}
```

The issue #270 `phase` names are mapped onto the existing flat lifecycle for compatibility:

- `active` stays active.
- `released`, `expired`, and `completed` stay terminal flat states.
- Reconciler-specific phases can be added later if #268 broadens `ClaimStatus`.

### ClaimView

Merged reads return the split shape:

```ts
export interface ClaimView {
  readonly spec: ClaimSpec;
  readonly status: ClaimStatusRecord;
}
```

Legacy reads still return flat `Claim`. The adapter derives:

- `claimId` from `spec.id`
- `targetRef`, `agent`, `intentSummary`, `context`, `createdAt` from `spec`
- `status`, `heartbeatAt`, `leaseExpiresAt`, `attemptCount`, `revision` from `status`

No caller should mutate DTOs returned by the store. Any mutation path must structured-clone or build a new object before writing.

## SQLite Schema

Add `claim_spec`:

```sql
CREATE TABLE IF NOT EXISTS claim_spec (
  id TEXT PRIMARY KEY,
  role_name TEXT,
  platform TEXT,
  blueprint TEXT,
  assignee_json TEXT,
  lease_deadline_sec INTEGER,
  priority INTEGER,
  max_iterations INTEGER,
  generation INTEGER NOT NULL DEFAULT 1,
  target_ref TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_json TEXT NOT NULL,
  intent_summary TEXT NOT NULL,
  context_json TEXT,
  created_at TEXT NOT NULL
);
```

Add `claim_status`:

```sql
CREATE TABLE IF NOT EXISTS claim_status (
  id TEXT PRIMARY KEY,
  phase TEXT NOT NULL DEFAULT 'active',
  observed_generation INTEGER NOT NULL DEFAULT 0,
  agent_session_id TEXT,
  last_heartbeat_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  current_contribution_cid TEXT,
  conditions_json TEXT NOT NULL DEFAULT '[]',
  last_transition_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (id) REFERENCES claim_spec(id) ON DELETE CASCADE
);
```

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_claim_spec_target ON claim_spec(target_ref);
CREATE INDEX IF NOT EXISTS idx_claim_spec_agent ON claim_spec(agent_id);
CREATE INDEX IF NOT EXISTS idx_claim_status_phase ON claim_status(phase);
CREATE INDEX IF NOT EXISTS idx_claim_status_phase_lease ON claim_status(phase, lease_expires_at);
```

The legacy `claims` table is left in place during migration for rollback safety, but SQLite store methods stop writing it after split migration. A later cleanup can drop it once all backends and releases have crossed the migration boundary.

## Migration

`CURRENT_SCHEMA_VERSION` increments by one.

On open:

1. Create `claim_spec` and `claim_status` if missing.
2. If legacy `claims` contains rows not present in `claim_spec`, copy them:
   - `claim_id` -> `claim_spec.id` and `claim_status.id`
   - `target_ref`, `agent_id`, `agent_json`, `intent_summary`, `context_json`, `created_at` -> `claim_spec`
   - `status`, `heartbeat_at`, `lease_expires_at`, `attempt_count`, `revision` -> `claim_status`
   - `generation` defaults to `revision` when present, otherwise `1`
   - `observed_generation` defaults to copied `generation`
   - `last_transition_at` defaults to `heartbeat_at`
   - `conditions_json` defaults to `[]`
3. Ensure re-opening an already migrated database does not duplicate rows or alter generations.

Fresh databases create only the split tables for active store behavior, while keeping legacy table creation harmless if older tests or manual tools inspect it.

## Store Contract

Extend `ClaimStore`:

```ts
putClaimSpec(spec: ClaimSpec): Promise<ClaimView>;
getClaimView(claimId: string): Promise<ClaimView | undefined>;
patchClaimStatus(claimId: string, patch: ClaimStatusPatch): Promise<ClaimView>;
```

`ClaimStatusPatch` is partial and status-only:

```ts
export interface ClaimStatusPatch {
  readonly phase?: ClaimStatus | undefined;
  readonly observedGeneration?: number | undefined;
  readonly agentSessionId?: string | undefined;
  readonly lastHeartbeatAt?: string | undefined;
  readonly leaseExpiresAt?: string | undefined;
  readonly currentContributionCid?: string | undefined;
  readonly conditions?: readonly Condition[] | undefined;
  readonly lastTransitionAt?: string | undefined;
}
```

Rules:

- `putClaimSpec` creates or replaces spec fields and increments `generation` for existing specs.
- `putClaimSpec` creates a default status row when creating a new claim.
- `putClaimSpec` never updates status columns.
- `patchClaimStatus` updates only status columns and increments `revision`.
- `patchClaimStatus` does not mutate spec or increment spec `generation`.
- `patchClaimStatus` may set `observedGeneration = spec.generation`.
- `getClaim`, `listClaims`, `activeClaims`, `heartbeat`, `release`, `complete`, `expireStale`, `countActiveClaims`, and `detectStalled` continue to work through joined split tables.

## HTTP Routes

All routes keep namespace bearer auth through existing middleware.

### `PUT /api/claims/:id`

Writes spec only.

Accepted body fields:

- `roleName`
- `platform`
- `blueprint`
- `assignee`
- `leaseDeadlineSec`
- `priority`
- `maxIterations`
- `targetRef`
- `agent`
- `intentSummary`
- `context`

Rejected body fields:

- `status`
- `phase`
- `observedGeneration`
- `agentSessionId`
- `lastHeartbeatAt`
- `heartbeatAt`
- `leaseExpiresAt`
- `currentContributionCid`
- `conditions`
- `lastTransitionAt`
- `revision`

Response: `200` with `{ spec, status }` for update, `201` with `{ spec, status }` for create.

### `PATCH /api/claims/:id/status`

Writes status only. Requires:

- existing namespace bearer token in `Authorization`
- controller token in `X-Grove-Controller-Token`

The token is configured by the server from `GROVE_CONTROLLER_TOKEN` and passed through `ServerDeps.controllerToken`. Missing or mismatched controller token returns `403`.

Accepted body fields:

- `phase`
- `observedGeneration`
- `agentSessionId`
- `lastHeartbeatAt`
- `leaseExpiresAt`
- `currentContributionCid`
- `conditions`
- `lastTransitionAt`

Rejected body fields:

- `roleName`
- `platform`
- `blueprint`
- `assignee`
- `leaseDeadlineSec`
- `priority`
- `maxIterations`
- `targetRef`
- `agent`
- `intentSummary`
- `context`
- `generation`
- `revision`

Response: `200` with `{ spec, status }`.

### `GET /api/claims/:id`

Returns merged split view:

```json
{
  "spec": {},
  "status": {}
}
```

Missing claim returns `404`.

### Legacy Routes

- `POST /api/claims` remains create-or-renew and returns flat `Claim`.
- `PATCH /api/claims/:id` remains heartbeat, release, or complete and returns flat `Claim`.
- `GET /api/claims` remains list and returns flat claims.

These routes internally use split storage.

## Watch and Entity Behavior

Spec writes emit `ADDED` for new claims and `MODIFIED` for existing claims. Status writes emit `MODIFIED`.

The Entity projection updates:

- `ClaimEntity.spec` includes the richer spec fields.
- `ClaimEntity.status` reads from `ClaimStatusRecord`.
- `metadata.generation` comes from `ClaimSpec.generation`.
- `observedGeneration` comes from `ClaimStatusRecord.observedGeneration`.
- `resourceVersion` comes from `ClaimStatusRecord.revision`, preserving the current lease-expired derived version behavior.

Existing watch consumers that use flat claims through `claimToEntity` continue to receive compatible condition and phase values.

## Auth Design

Controller authorization is intentionally narrow:

- Namespace auth remains the global gate for `/api/*`.
- Only `PATCH /api/claims/:id/status` checks the controller token.
- The token is not a namespace key and does not grant read access by itself.
- The token is compared exactly to `X-Grove-Controller-Token`.

This avoids changing `server-keys.yaml` semantics while giving #268 a protected status-write surface.

## Testing

### SQLite Migration Tests

- Fresh database has `claim_spec` and `claim_status`.
- Legacy database with populated `claims` backfills both split tables.
- Re-open after migration does not duplicate rows.
- Existing legacy claim remains readable through `getClaim`.

### Store Conformance Tests

- `putClaimSpec` creates spec and default status.
- `putClaimSpec` increments `generation` without changing status `revision`.
- `patchClaimStatus` updates status and increments `revision` without changing spec `generation`.
- `getClaimView` returns `{ spec, status }`.
- Legacy `heartbeat`, `release`, and `complete` update status only.
- Legacy `claimOrRenew` renews same-agent active claims without rewriting spec-owned fields except the intended `intentSummary` compatibility field.

### HTTP Tests

- `PUT /api/claims/:id` rejects status-owned fields.
- `PATCH /api/claims/:id/status` rejects spec-owned fields.
- `PATCH /api/claims/:id/status` returns `403` with missing or wrong controller token.
- `PATCH /api/claims/:id/status` succeeds with namespace auth plus controller token.
- `GET /api/claims/:id` returns `{ spec, status }`.
- Legacy routes keep existing response shape.

### Verification Commands

Once Bun is available:

```bash
bun test tests/server/claims.test.ts src/local/sqlite-store.test.ts src/local/sqlite-store.migration.test.ts src/core/claim-store.conformance.ts src/core/entity.test.ts
bun run typecheck
bun run check
```

## Risks

- The split introduces duplicated compatibility semantics between flat `Claim` and split `ClaimView`. Keep conversion helpers centralized to avoid drift.
- Nexus is VFS-backed, so it will enforce spec/status ownership through the new `ClaimStore` methods rather than SQLite tables. Its compatibility path must pass the same store contract tests without breaking existing Nexus consumers.
- Controller-token config is new operational surface. Missing config should fail status writes clearly without affecting normal claim use.

## Acceptance Criteria

- `claim_spec` and `claim_status` exist and are used by SQLite claim writes.
- User spec writes cannot update status-owned fields.
- Controller status writes cannot update spec-owned fields.
- Status writes require a controller token.
- `GET /api/claims/:id` returns `{ spec, status }`.
- Legacy claim routes and store methods remain compatible.
- The reconciler can read a claim view and write status only with `observedGeneration = spec.generation`.
