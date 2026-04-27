# A3: Namespace Server-Enforced Isolation — Design

- **Issue**: [#290](https://github.com/windoliver/grove/issues/290)
- **Epic**: [#282](https://github.com/windoliver/grove/issues/282) — Foundation: Entity Model + Watch Protocol
- **Date**: 2026-04-26
- **Depends on**: #287 (Entity envelope), #288 (Project UUID)

## Goal

Enforce hard namespace isolation at the HTTP layer so that no request can read
or write data belonging to a different `{project-uuid}/{worktree-name}` pair.
Every API call must carry a bearer token that resolves to exactly one namespace;
the resolved namespace flows down to the Nexus zoneId, making cross-namespace
reads structurally impossible rather than just rejected.

## Non-goals

- JWT / asymmetric signing. Opaque random keys are sufficient for local/trusted-network use.
- Key rotation CLI (`grove key rotate`). Re-running `grove init` appends a new key; old keys remain valid until manually removed.
- Multi-tenant Nexus (a zone-above-namespace concept). Rollup views are client-side joins per the issue spec.
- Migration of pre-#290 data seeded under `"default"` zoneId. That is #291.
- Watch protocol enforcement. A5 (#292) adds `/watch`; namespace middleware applies to it automatically when it lands.

## Namespace format

```
namespace = "{project-uuid}/{worktree-name}"

Examples:
  550e8400-e29b-41d4-a716-446655440000/main
  550e8400-e29b-41d4-a716-446655440000/feature-auth
```

`worktree-name` derivation (fallback chain, implemented in `detectWorktreeName()`):
1. Name from `git worktree list --porcelain` for the current worktree
2. Current branch name (`git rev-parse --abbrev-ref HEAD`)
3. Literal `"main"`

## Architecture

```
grove init
  ├── readProjectId()          (already exists, #288)
  ├── detectWorktreeName()     (new)
  ├── namespace = "{projectId}/{worktreeName}"
  ├── key = "grv_" + randomBytes(32).toString("hex")
  ├── write .grove/api-key           (gitignored, client credential)
  └── append .grove/server-keys.yaml (gitignored, server registry entry)

grove up / grove serve
  └── loadKeyRegistry(".grove/server-keys.yaml") → Map<key, namespace>

HTTP request lifecycle:
  Request
    → namespaceAuth middleware
        ├── no Authorization header   → 400 namespace_missing
        ├── key not in registry       → 401 namespace_unauthorized
        └── key found → c.set("namespace", ns)
                            ↓
                    route handler
                            ↓
                    storeFactory(nexusClient, namespace)
                            ↓
                    Nexus VFS: /zones/{namespace}/...
```

## File changes

### New files

**`src/server/middleware/namespace-auth.ts`**

```typescript
type KeyRegistry = Map<string, string>  // key → namespace

export function loadKeyRegistry(serverKeysPath: string): KeyRegistry
export function namespaceAuth(registry: KeyRegistry): MiddlewareHandler
```

`loadKeyRegistry` reads `.grove/server-keys.yaml`. If the file is absent,
returns an empty Map — all API calls will return 400 until `grove init` is run.
No silent fallback to `"default"`.

**`src/core/project-key.ts`**

```typescript
export function detectWorktreeName(): Promise<string>
export function generateApiKey(): string          // "grv_" + 64 hex chars
export function writeClientKey(groveDir: string, key: string): Promise<void>
export function appendServerKey(
  groveDir: string,
  key: string,
  namespace: string,
): Promise<void>
```

### Modified files

**`src/cli/commands/init.ts`**
- After `ensureProjectId()`: call `detectWorktreeName()`, compute namespace,
  generate key, write `.grove/api-key`, append `.grove/server-keys.yaml`,
  ensure both paths in `.grove/.gitignore`.

**`src/server/app.ts`**
- Accept `registry: KeyRegistry` in the app factory options.
- Mount `namespaceAuth(registry)` on `"/api/*"` after the request-size
  middleware. Move the health route from `/api/health` to `/health` so it
  falls outside the `/api/*` auth guard.

**`src/server/serve.ts`**
- Remove `const zoneId = process.env.GROVE_ZONE_ID ?? "default"` and the
  `GROVE_ZONE_ID` env var entirely.
- Call `loadKeyRegistry(path.join(groveDir, "server-keys.yaml"))` at startup.
- Pass `registry` into `createApp`.
- All store factory calls replace the old `zoneId` argument with
  `c.get("namespace")` inside route handlers.

**`src/core/entity.ts`**
- All three adapter functions (`contributionToEntity`, `claimToEntity`,
  `agentSessionToEntity`) gain a required `namespace: string` parameter.
- Remove the `namespace: "default"` hardcoding and the comment referencing #290.
- Call sites in route handlers pass `c.get("namespace")`.

### Storage files (gitignored)

**`.grove/api-key`** — one line, the client credential:
```
grv_a1b2c3d4e5f6...
```

**`.grove/server-keys.yaml`** — append-only registry:
```yaml
version: 1
keys:
  grv_a1b2c3d4e5f6...:
    namespace: "550e8400-e29b-41d4-a716-446655440000/feature-auth"
    createdAt: "2026-04-26T10:00:00.000Z"
```

Re-running `grove init` appends a new entry. Old entries remain valid. Manual
removal from this file is the rotation mechanism.

## Error model

Two new error classes (added to the existing `GroveError` hierarchy):

| Class | HTTP | Code |
|---|---|---|
| `NamespaceMissingError` | 400 | `namespace_missing` |
| `NamespaceUnauthorizedError` | 401 | `namespace_unauthorized` |

Response body follows the existing error-handler format:
```json
{"error": "namespace_missing", "message": "Authorization: Bearer <key> header required"}
```

Cross-namespace access is structurally impossible: the namespace is always
derived from the key, so a key for A can never address B's zoneId. No explicit
403 path is needed — the store returns empty results for a different zoneId by
definition.

## Testing

### Middleware unit tests (`src/server/middleware/namespace-auth.test.ts`)

- Missing `Authorization` header → 400 `namespace_missing`
- Unknown key → 401 `namespace_unauthorized`
- Valid key → `c.get("namespace")` equals the registered namespace
- `/health` with no key → 200 (exempt, moved off `/api/*`)

### Two-worktree isolation integration test

```
registry: { keyA → "uuid/worktree-a", keyB → "uuid/worktree-b" }

POST /api/contributions (keyA) → 201, entity.namespace = "uuid/worktree-a"
GET  /api/contributions (keyB) → 200, results = []   (different zoneId, empty store)
```

Verified by asserting the Nexus VFS path called contains `"uuid/worktree-a"` for
keyA requests and `"uuid/worktree-b"` for keyB requests — never mixed.

### Key generation unit tests (`src/core/project-key.test.ts`)

- `detectWorktreeName()` returns branch name in main checkout
- `detectWorktreeName()` returns worktree name in detached worktree
- `generateApiKey()` returns string matching `/^grv_[0-9a-f]{64}$/`
- `writeClientKey` overwrites `.grove/api-key` (idempotent)
- `appendServerKey` appends; second call produces two valid entries

### Negative tests

- `GET /api/contributions` with no `Authorization` → 400
- `GET /api/contributions` with unknown key → 401
- `GET /health` with no `Authorization` → 200

## Acceptance criteria (from issue)

| Criterion | How satisfied |
|---|---|
| Two worktrees, same repo → separate namespaces, no cross-reads server-side | Different keys → different zoneIds → disjoint Nexus VFS paths |
| API key in namespace A → 403 against namespace B | Structurally impossible: key lookup always resolves to own namespace; B's zoneId is never addressed |
| `/watch?kind=X` without namespace → 400 | `namespaceAuth` middleware covers `/api/*`; watch endpoint gets the same enforcement when A5 lands |
| Label selector scoped within current namespace only | Labels are intra-store filters; store is already scoped to one zoneId = one namespace |
