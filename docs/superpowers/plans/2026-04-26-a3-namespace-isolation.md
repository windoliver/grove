# A3: Namespace Server-Enforced Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce hard namespace isolation (`{project-uuid}/{worktree-name}`) at the HTTP layer so every API call must carry a bearer token that resolves to the server's namespace, with the resolved namespace flowing down to the Nexus zoneId.

**Architecture:** A new Hono middleware (`namespaceAuth`) validates the `Authorization: Bearer <key>` header against an in-memory registry loaded from `.grove/server-keys.yaml` at startup. The registry maps opaque keys to namespaces. The resolved namespace replaces the `GROVE_ZONE_ID` env var as the Nexus zoneId. Entity adapters (`contributionToEntity`, `claimToEntity`) gain a required `namespace` parameter so Nexus stores surface the correct namespace in entity envelopes.

**Tech Stack:** TypeScript, Bun (test runner), Hono (middleware), `yaml` library (YAML parse/stringify), Node.js `crypto` (key generation), Node.js `child_process` (git worktree detection).

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Create | `src/core/project-key.ts` | Key gen, worktree detection, api-key/server-keys.yaml I/O |
| Create | `src/core/project-key.test.ts` | Unit tests for project-key.ts |
| Create | `src/server/middleware/namespace-auth.ts` | `loadKeyRegistry`, `namespaceAuth` middleware |
| Create | `src/server/middleware/namespace-auth.test.ts` | Unit tests for namespace-auth.ts |
| Modify | `src/core/errors.ts` | Add `NamespaceMissingError`, `NamespaceUnauthorizedError` |
| Modify | `src/server/middleware/error-handler.ts` | Register new errors in `ERROR_MAP` |
| Modify | `src/server/middleware/error-handler.test.ts` | Tests for new error mappings |
| Modify | `src/server/deps.ts` | Add `namespace: string` to `ServerEnv.Variables` |
| Modify | `src/server/app.ts` | Accept `registry` param, mount `namespaceAuth`, move health to `/health` |
| Modify | `src/server/serve.ts` | Derive namespace from project-id+worktree, load registry, pass to createApp |
| Modify | `src/core/entity.ts` | Add `namespace` param to `contributionToEntity`, `claimToEntity`; optional to `agentSessionToEntity` |
| Modify | `src/nexus/nexus-contribution-store.ts` | Pass `this.zoneId` to `contributionToEntity` |
| Modify | `src/nexus/nexus-claim-store.ts` | Pass `this.zoneId` to `claimToEntity` |
| Modify | `src/local/sqlite-store.ts` | Pass `"default"` to both entity adapters |
| Modify | `src/cli/commands/init.ts` | Generate api-key + append server-keys.yaml after `ensureProjectId` |

---

## Task 1: Error Classes

**Files:**
- Modify: `src/core/errors.ts`
- Modify: `src/server/middleware/error-handler.ts`
- Modify: `src/server/middleware/error-handler.test.ts`

- [ ] **Step 1: Write failing tests for new error HTTP mappings**

Add to the bottom of `src/server/middleware/error-handler.test.ts`, inside the existing `describe("error handler", ...)` block, after the last `it(...)`:

```typescript
  it("maps NamespaceMissingError to 400", async () => {
    const { NamespaceMissingError } = await import("../../core/errors.js");
    const app = appThatThrows(new NamespaceMissingError());

    const res = await app.request("/test");
    expect(res.status).toBe(400);
    const data = (await res.json()) as Json;
    expect(data.error.code).toBe("NAMESPACE_MISSING");
    expect(data.error.message).toContain("Authorization");
  });

  it("maps NamespaceUnauthorizedError to 401", async () => {
    const { NamespaceUnauthorizedError } = await import("../../core/errors.js");
    const app = appThatThrows(new NamespaceUnauthorizedError());

    const res = await app.request("/test");
    expect(res.status).toBe(401);
    const data = (await res.json()) as Json;
    expect(data.error.code).toBe("NAMESPACE_UNAUTHORIZED");
  });
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test src/server/middleware/error-handler.test.ts
```

Expected: FAIL — `NamespaceMissingError` and `NamespaceUnauthorizedError` not exported from `../../core/errors.js`.

- [ ] **Step 3: Add error classes to src/core/errors.ts**

Append after the last class in the file (after `PolicyViolationError` / `LeaseViolationError`):

```typescript
/** Thrown when no Authorization header is present on an API request. */
export class NamespaceMissingError extends GroveError {
  constructor() {
    super("Authorization: Bearer <key> header required");
    this.name = "NamespaceMissingError";
  }
}

/** Thrown when the bearer token is not in the server's key registry. */
export class NamespaceUnauthorizedError extends GroveError {
  constructor() {
    super("Bearer token not recognized");
    this.name = "NamespaceUnauthorizedError";
  }
}
```

- [ ] **Step 4: Register errors in ERROR_MAP (error-handler.ts)**

In `src/server/middleware/error-handler.ts`, add two entries to the `ERROR_MAP` after the `"StateConflictError"` line:

```typescript
  ["NamespaceMissingError", { status: 400, code: "NAMESPACE_MISSING" }],
  ["NamespaceUnauthorizedError", { status: 401, code: "NAMESPACE_UNAUTHORIZED" }],
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
bun test src/server/middleware/error-handler.test.ts
```

Expected: All tests PASS including the two new ones.

- [ ] **Step 6: Commit**

```bash
git add src/core/errors.ts src/server/middleware/error-handler.ts src/server/middleware/error-handler.test.ts
git commit -m "feat(a3): add NamespaceMissingError and NamespaceUnauthorizedError"
```

---

## Task 2: project-key.ts — Key Generation & Worktree Detection

**Files:**
- Create: `src/core/project-key.ts`
- Create: `src/core/project-key.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/project-key.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendServerKey,
  generateApiKey,
  writeClientKey,
} from "./project-key.js";

// detectWorktreeName requires a real git repo — tested in integration only

describe("generateApiKey", () => {
  it("returns a string matching grv_ + 64 hex chars", () => {
    const key = generateApiKey();
    expect(key).toMatch(/^grv_[0-9a-f]{64}$/);
  });

  it("returns a different key on each call", () => {
    expect(generateApiKey()).not.toBe(generateApiKey());
  });
});

describe("writeClientKey / appendServerKey", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `grove-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writeClientKey writes grv_ key to api-key file", async () => {
    const key = generateApiKey();
    await writeClientKey(dir, key);
    const content = readFileSync(join(dir, "api-key"), "utf8").trim();
    expect(content).toBe(key);
  });

  it("writeClientKey overwrites on second call (idempotent)", async () => {
    await writeClientKey(dir, "grv_" + "a".repeat(64));
    await writeClientKey(dir, "grv_" + "b".repeat(64));
    const content = readFileSync(join(dir, "api-key"), "utf8").trim();
    expect(content).toBe("grv_" + "b".repeat(64));
  });

  it("appendServerKey creates server-keys.yaml with correct structure", async () => {
    const key = "grv_" + "a".repeat(64);
    await appendServerKey(dir, key, "uuid-1234/main");
    const raw = readFileSync(join(dir, "server-keys.yaml"), "utf8");
    expect(raw).toContain("version: 1");
    expect(raw).toContain(key);
    expect(raw).toContain("uuid-1234/main");
  });

  it("appendServerKey appends a second key without removing the first", async () => {
    const keyA = "grv_" + "a".repeat(64);
    const keyB = "grv_" + "b".repeat(64);
    await appendServerKey(dir, keyA, "uuid-1234/main");
    await appendServerKey(dir, keyB, "uuid-1234/main");
    const raw = readFileSync(join(dir, "server-keys.yaml"), "utf8");
    expect(raw).toContain(keyA);
    expect(raw).toContain(keyB);
  });

  it("appendServerKey creates server-keys.yaml if absent", async () => {
    expect(existsSync(join(dir, "server-keys.yaml"))).toBe(false);
    await appendServerKey(dir, "grv_" + "c".repeat(64), "uuid/worktree");
    expect(existsSync(join(dir, "server-keys.yaml"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test src/core/project-key.test.ts
```

Expected: FAIL — `project-key.js` module not found.

- [ ] **Step 3: Implement src/core/project-key.ts**

Create `src/core/project-key.ts`:

```typescript
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const CLIENT_KEY_FILE = "api-key";
export const SERVER_KEYS_FILE = "server-keys.yaml";

/** Generate a unique opaque bearer token prefixed with `grv_`. */
export function generateApiKey(): string {
  return `grv_${randomBytes(32).toString("hex")}`;
}

/**
 * Detect the current git worktree name (branch name or commit hash fallback).
 * Returns "main" if git is unavailable or in a detached HEAD with no branch.
 */
export async function detectWorktreeName(): Promise<string> {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (branch && branch !== "HEAD") {
      // Sanitize: replace chars invalid in a URL path segment
      return branch.replace(/[^a-zA-Z0-9._-]/g, "-");
    }
    // Detached HEAD — use short commit hash
    const sha = execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return sha || "main";
  } catch {
    return "main";
  }
}

/** Write the client credential to `<groveDir>/api-key` (overwrites). */
export async function writeClientKey(groveDir: string, key: string): Promise<void> {
  const target = join(groveDir, CLIENT_KEY_FILE);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${key}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, target);
}

interface ServerKeysFile {
  version: 1;
  keys: Record<string, { namespace: string; createdAt: string }>;
}

/** Append a key → namespace entry to `<groveDir>/server-keys.yaml`. */
export async function appendServerKey(
  groveDir: string,
  key: string,
  namespace: string,
): Promise<void> {
  const path = join(groveDir, SERVER_KEYS_FILE);
  let existing: ServerKeysFile = { version: 1, keys: {} };
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = parseYaml(raw) as ServerKeysFile;
    if (parsed?.version === 1 && parsed.keys) {
      existing = parsed;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  existing.keys[key] = { namespace, createdAt: new Date().toISOString() };
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, stringifyYaml(existing), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test src/core/project-key.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/project-key.ts src/core/project-key.test.ts
git commit -m "feat(a3): add project-key helpers — generateApiKey, detectWorktreeName, write/append"
```

---

## Task 3: namespace-auth Middleware

**Files:**
- Create: `src/server/middleware/namespace-auth.ts`
- Create: `src/server/middleware/namespace-auth.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/server/middleware/namespace-auth.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { NamespaceMissingError, NamespaceUnauthorizedError } from "../../core/errors.js";
import { handleError } from "./error-handler.js";
import { loadKeyRegistry, namespaceAuth } from "./namespace-auth.js";

// biome-ignore lint/suspicious/noExplicitAny: test file
type Json = Record<string, any>;

function makeApp(registry: Map<string, string>): Hono {
  const app = new Hono<{ Variables: { namespace: string } }>();
  app.use("/api/*", namespaceAuth(registry));
  app.get("/api/ping", (c) => c.json({ namespace: c.get("namespace") }));
  app.get("/health", (c) => c.json({ ok: true }));
  app.onError(handleError);
  return app;
}

describe("loadKeyRegistry", () => {
  it("returns empty Map when file is absent", async () => {
    const registry = loadKeyRegistry("/nonexistent/path/server-keys.yaml");
    expect(registry.size).toBe(0);
  });
});

describe("namespaceAuth middleware", () => {
  const registry = new Map([
    ["grv_" + "a".repeat(64), "uuid-a/worktree-a"],
    ["grv_" + "b".repeat(64), "uuid-b/worktree-b"],
  ]);

  it("returns 400 when Authorization header is absent", async () => {
    const app = makeApp(registry);
    const res = await app.request("/api/ping");
    expect(res.status).toBe(400);
    const data = (await res.json()) as Json;
    expect(data.error.code).toBe("NAMESPACE_MISSING");
  });

  it("returns 400 when Authorization header has wrong scheme", async () => {
    const app = makeApp(registry);
    const res = await app.request("/api/ping", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as Json;
    expect(data.error.code).toBe("NAMESPACE_MISSING");
  });

  it("returns 401 when key is not in registry", async () => {
    const app = makeApp(registry);
    const res = await app.request("/api/ping", {
      headers: { Authorization: "Bearer grv_unknown_key" },
    });
    expect(res.status).toBe(401);
    const data = (await res.json()) as Json;
    expect(data.error.code).toBe("NAMESPACE_UNAUTHORIZED");
  });

  it("sets namespace in context for a valid key", async () => {
    const app = makeApp(registry);
    const res = await app.request("/api/ping", {
      headers: { Authorization: `Bearer grv_${"a".repeat(64)}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Json;
    expect(data.namespace).toBe("uuid-a/worktree-a");
  });

  it("resolves different namespaces for different keys", async () => {
    const app = makeApp(registry);
    const resA = await app.request("/api/ping", {
      headers: { Authorization: `Bearer grv_${"a".repeat(64)}` },
    });
    const resB = await app.request("/api/ping", {
      headers: { Authorization: `Bearer grv_${"b".repeat(64)}` },
    });
    expect(((await resA.json()) as Json).namespace).toBe("uuid-a/worktree-a");
    expect(((await resB.json()) as Json).namespace).toBe("uuid-b/worktree-b");
  });

  it("does not enforce auth on routes outside /api/*", async () => {
    const app = makeApp(registry);
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test src/server/middleware/namespace-auth.test.ts
```

Expected: FAIL — `namespace-auth.js` module not found.

- [ ] **Step 3: Implement src/server/middleware/namespace-auth.ts**

Create `src/server/middleware/namespace-auth.ts`:

```typescript
import { readFileSync } from "node:fs";
import type { MiddlewareHandler } from "hono";
import { parse as parseYaml } from "yaml";
import { NamespaceMissingError, NamespaceUnauthorizedError } from "../../core/errors.js";

export type KeyRegistry = Map<string, string>; // key → namespace

interface ServerKeysFile {
  version: 1;
  keys: Record<string, { namespace: string; createdAt: string }>;
}

/**
 * Load `.grove/server-keys.yaml` into an in-memory Map<key, namespace>.
 * Returns an empty Map if the file is absent (all API calls will return 400
 * until `grove init` has been run).
 */
export function loadKeyRegistry(serverKeysPath: string): KeyRegistry {
  let raw: string;
  try {
    raw = readFileSync(serverKeysPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
  const parsed = parseYaml(raw) as ServerKeysFile | null;
  if (!parsed?.keys) return new Map();
  const registry: KeyRegistry = new Map();
  for (const [key, entry] of Object.entries(parsed.keys)) {
    if (entry?.namespace) registry.set(key, entry.namespace);
  }
  return registry;
}

/**
 * Hono middleware that enforces namespace-scoped bearer-token auth on /api/*.
 *
 * On success: sets `c.get("namespace")` to the resolved namespace string.
 * On failure: throws NamespaceMissingError (→ 400) or NamespaceUnauthorizedError (→ 401).
 */
export function namespaceAuth(registry: KeyRegistry): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.req.header("Authorization");
    if (!auth?.startsWith("Bearer ")) {
      throw new NamespaceMissingError();
    }
    const key = auth.slice(7).trim();
    const ns = registry.get(key);
    if (!ns) {
      throw new NamespaceUnauthorizedError();
    }
    c.set("namespace", ns);
    await next();
  };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test src/server/middleware/namespace-auth.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/middleware/namespace-auth.ts src/server/middleware/namespace-auth.test.ts
git commit -m "feat(a3): add namespaceAuth middleware with loadKeyRegistry"
```

---

## Task 4: Wire Middleware into app.ts + Update deps.ts

**Files:**
- Modify: `src/server/deps.ts`
- Modify: `src/server/app.ts`

- [ ] **Step 1: Add `namespace` to ServerEnv.Variables in deps.ts**

In `src/server/deps.ts`, update the `ServerEnv` interface:

```typescript
/** Hono environment type carrying injected dependencies. */
export interface ServerEnv {
  Variables: {
    deps: ServerDeps;
    namespace: string;
  };
}
```

- [ ] **Step 2: Update createApp to accept registry and mount middleware**

Replace the entire `src/server/app.ts` with:

```typescript
/**
 * Grove HTTP server application factory.
 *
 * createApp(deps, registry) returns a Hono application with all routes mounted.
 * Dependencies are injected via context variables, enabling easy testing.
 *
 * ## Security / Auth Model
 *
 * All /api/* routes require a valid bearer token from `.grove/server-keys.yaml`.
 * The token resolves to a namespace that is injected into each request context.
 * Requests without a valid token receive 400 (missing) or 401 (unrecognized).
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { KeyRegistry } from "./middleware/namespace-auth.js";
import { namespaceAuth } from "./middleware/namespace-auth.js";
import type { ServerDeps, ServerEnv } from "./deps.js";
import { handleError } from "./middleware/error-handler.js";
import { agents } from "./routes/agents.js";
import { boardroom } from "./routes/boardroom.js";
import { bounties } from "./routes/bounties.js";
import { claims } from "./routes/claims.js";
import { contributions } from "./routes/contributions.js";
import { dag } from "./routes/dag.js";
import { diff } from "./routes/diff.js";
import { frontier } from "./routes/frontier.js";
import { goals } from "./routes/goals.js";
import { gossip } from "./routes/gossip.js";
import { grove } from "./routes/grove.js";
import { handoffs } from "./routes/handoffs.js";
import { health } from "./routes/health.js";
import { outcomes } from "./routes/outcomes.js";
import { search } from "./routes/search.js";
import { sessions } from "./routes/sessions.js";
import { threads } from "./routes/threads.js";

/**
 * Create a Hono application with all grove-server routes.
 *
 * @param deps - Injected dependencies (stores, CAS, frontier calculator).
 * @param registry - Bearer-token → namespace registry loaded from server-keys.yaml.
 * @returns Configured Hono application.
 */
export function createApp(deps: ServerDeps, registry: KeyRegistry): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();

  // Global body-size limit (10 MB)
  app.use("*", bodyLimit({ maxSize: 10 * 1024 * 1024 }));

  // Inject dependencies into every request's context
  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  // Health check — exempt from namespace auth (used by grove up readiness probes)
  app.route("/health", health);

  // All /api/* routes require a valid namespace bearer token
  app.use("/api/*", namespaceAuth(registry));

  // Mount route groups
  app.route("/api/agents", agents);
  app.route("/api/boardroom", boardroom);
  app.route("/api/contributions", contributions);
  app.route("/api/frontier", frontier);
  app.route("/api/search", search);
  app.route("/api/dag", dag);
  app.route("/api/diff", diff);
  app.route("/api/threads", threads);
  app.route("/api/claims", claims);
  app.route("/api/bounties", bounties);
  app.route("/api/gossip", gossip);
  app.route("/api/grove", grove);
  app.route("/api/outcomes", outcomes);
  app.route("/api/session", goals);
  app.route("/api/sessions", sessions);
  app.route("/api/handoffs", handoffs);

  // Centralized error handling
  app.onError(handleError);

  return app;
}
```

- [ ] **Step 3: Run type check to confirm no errors**

```bash
bun tsc --noEmit 2>&1 | head -30
```

Expected: Errors only from `serve.ts` (which now calls `createApp(deps)` with wrong arity). No errors in `app.ts` or `deps.ts`.

- [ ] **Step 4: Run existing tests to confirm health route still tested via /health**

```bash
bun test src/server/middleware/error-handler.test.ts src/server/middleware/namespace-auth.test.ts
```

Expected: All PASS. (Note: existing tests that hit `/api/health` will need to be updated to `/health` — check and fix any such tests in the next step.)

- [ ] **Step 5: Search for /api/health in tests and fix**

```bash
grep -rn "api/health" /Users/tafeng/grove/src --include="*.test.ts" --include="*.test.tsx"
```

If any tests reference `/api/health`, change each occurrence to `/health`.

- [ ] **Step 6: Commit**

```bash
git add src/server/deps.ts src/server/app.ts
git commit -m "feat(a3): wire namespaceAuth on /api/*, move health to /health, add namespace to ServerEnv"
```

---

## Task 5: Update serve.ts — Namespace Derivation + Registry Loading

**Files:**
- Modify: `src/server/serve.ts`

- [ ] **Step 1: Replace GROVE_ZONE_ID with namespace derived from project-id + worktree**

In `src/server/serve.ts`:

1. Find and **delete** line 98:
```typescript
const zoneId = process.env.GROVE_ZONE_ID ?? "default";
```

2. Add these lines in its place, just before the `if (nexusUrl) {` block:

```typescript
const { readProjectId } = await import("../core/project-id.js");
const { detectWorktreeName, loadKeyRegistry: _loadKeyRegistry } = await import(
  "../core/project-key.js"
);
const { loadKeyRegistry } = await import("./middleware/namespace-auth.js");

const projectId = readProjectId(GROVE_DIR);
const worktreeName = await detectWorktreeName();
const zoneId = projectId ? `${projectId}/${worktreeName}` : "default";
if (!projectId) {
  console.warn(
    "grove-server: no project-id found — namespace defaults to 'default'. Run `grove init`.",
  );
}

const registry = loadKeyRegistry(join(GROVE_DIR, "server-keys.yaml"));
if (registry.size === 0) {
  console.warn(
    "grove-server: server-keys.yaml is absent or empty — all API calls will return 400. Run `grove init`.",
  );
}
```

3. Find line 179:
```typescript
const app = createApp(deps);
```
Replace with:
```typescript
const app = createApp(deps, registry);
```

- [ ] **Step 2: Run type check**

```bash
bun tsc --noEmit 2>&1 | head -30
```

Expected: No TypeScript errors in `serve.ts` or `app.ts`.

- [ ] **Step 3: Verify grove-server still starts in local mode (no Nexus)**

```bash
GROVE_DIR=/tmp/grove-test-ns PORT=14515 timeout 3 bun src/server/serve.ts 2>&1 || true
```

Expected: Server starts, prints warning about missing project-id, then listens. No crash.

- [ ] **Step 4: Commit**

```bash
git add src/server/serve.ts
git commit -m "feat(a3): derive zoneId from project-id+worktree, load key registry at startup"
```

---

## Task 6: Entity Adapters — Add namespace Parameter

**Files:**
- Modify: `src/core/entity.ts`
- Modify: `src/nexus/nexus-contribution-store.ts`
- Modify: `src/nexus/nexus-claim-store.ts`
- Modify: `src/local/sqlite-store.ts`

- [ ] **Step 1: Update contributionToEntity signature in entity.ts**

In `src/core/entity.ts`, change line 79:

```typescript
// BEFORE:
export function contributionToEntity(c: Contribution): ContributionEntity {

// AFTER:
export function contributionToEntity(c: Contribution, namespace: string): ContributionEntity {
```

Change line 90 inside the function:

```typescript
// BEFORE:
    namespace: "default",

// AFTER:
    namespace,
```

Remove the comment on lines 8-10:
```typescript
// BEFORE (delete these lines):
// Namespace is hardcoded to "default" until #290 lands server-enforced
// isolation. That is the only call-site that needs to change.
```

- [ ] **Step 2: Update claimToEntity signature in entity.ts**

The actual signature at line 159 is:

```typescript
export function claimToEntity(c: Claim, now: () => number = () => Date.now()): ClaimEntity {
```

`entity.test.ts` passes `claimClock` as the second arg (`claimToEntity(makeClaim(), claimClock)`), so namespace **must be the third** parameter to avoid breaking that call site:

```typescript
export function claimToEntity(
  c: Claim,
  now: () => number = () => Date.now(),
  namespace = "default",
): ClaimEntity {
```

Inside the function body, change `namespace: "default"` (line ~208) to `namespace`.

- [ ] **Step 3: Update agentSessionToEntity signature in entity.ts**

Find `agentSessionToEntity` (line 269). Current signature:

```typescript
export function agentSessionToEntity(
  s: AgentSession,
  now: () => string = () => UNKNOWN_TRANSITION_TIME,
): AgentSessionEntity {
```

Add `namespace = "default"` as a third parameter (after `now`) so existing callers need no changes:

```typescript
export function agentSessionToEntity(
  s: AgentSession,
  now: () => string = () => UNKNOWN_TRANSITION_TIME,
  namespace = "default",
): AgentSessionEntity {
```

Inside the function body, change `namespace: "default"` (line ~288) to `namespace`.

- [ ] **Step 4: Run type check to see which call sites break**

```bash
bun tsc --noEmit 2>&1 | grep "entity"
```

Expected: Errors at `contributionToEntity` call sites in `nexus-contribution-store.ts:686` and `sqlite-store.ts:1238`, and `claimToEntity` call sites in `nexus-claim-store.ts:449` and `sqlite-store.ts:1711`.

- [ ] **Step 5: Fix nexus-contribution-store.ts**

In `src/nexus/nexus-contribution-store.ts` at line 686, change:

```typescript
// BEFORE:
    return items.map(contributionToEntity);

// AFTER:
    return items.map((c) => contributionToEntity(c, this.zoneId));
```

- [ ] **Step 6: Fix nexus-claim-store.ts**

In `src/nexus/nexus-claim-store.ts` at line 449, change:

```typescript
// BEFORE:
    const entities = items.map((c) => claimToEntity(c));

// AFTER:
    const entities = items.map((c) => claimToEntity(c, () => Date.now(), this.zoneId));
```

`now` is the second param with a default, but must be passed explicitly here so namespace (third param) can be `this.zoneId`.

- [ ] **Step 7: Fix sqlite-store.ts**

In `src/local/sqlite-store.ts` at line 1238, change:

```typescript
// BEFORE:
    return items.map(contributionToEntity);

// AFTER:
    return items.map((c) => contributionToEntity(c, "default"));
```

At line 1711, change:

```typescript
// BEFORE:
    const entities = items.map((c) => claimToEntity(c));

// AFTER:
    const entities = items.map((c) => claimToEntity(c, "default"));
```

- [ ] **Step 8: Fix test call sites for contributionToEntity**

`contributionToEntity` now requires `namespace`. Two test files use it as a bare function reference in `.map()` — the array index would be passed as namespace, causing a TypeScript error.

In `src/core/policy-enforcer.test.ts` at line 119, change:

```typescript
// BEFORE:
      return result.map(contributionToEntity);

// AFTER:
      return result.map((c) => contributionToEntity(c, "default"));
```

In `src/core/entity.test.ts`, all `contributionToEntity(makeContribution())` calls gain a second arg. Find every call:

```bash
grep -n "contributionToEntity(" src/core/entity.test.ts
```

For each call that passes only one argument, add `"default"` as the second:

```typescript
// BEFORE:
    const e: ContributionEntity = contributionToEntity(makeContribution());
// AFTER:
    const e: ContributionEntity = contributionToEntity(makeContribution(), "default");
```

Apply this change to all occurrences in `entity.test.ts`.

- [ ] **Step 9: Run type check — should be clean**

```bash
bun tsc --noEmit 2>&1 | head -20
```

Expected: Zero errors.

- [ ] **Step 9: Run full test suite**

```bash
bun test
```

Expected: All existing tests PASS. (No tests directly assert entity namespace values yet — those come in Task 8.)

- [ ] **Step 10: Commit**

```bash
git add src/core/entity.ts src/nexus/nexus-contribution-store.ts src/nexus/nexus-claim-store.ts src/local/sqlite-store.ts src/core/policy-enforcer.test.ts src/core/entity.test.ts
git commit -m "feat(a3): thread namespace through entity adapters — Nexus stores use zoneId, SQLite uses 'default'"
```

---

## Task 7: grove init — Key Generation

**Files:**
- Modify: `src/cli/commands/init.ts`

- [ ] **Step 1: Add key generation after ensureProjectId**

In `src/cli/commands/init.ts`, find line 221:

```typescript
  const projectId = ensureResult.id;
```

Add the following block immediately after line 221 (before the `try {` on line ~229):

```typescript
  // 3c. Generate namespace key for this worktree (spec #290).
  //     Writes .grove/api-key (client credential) and appends to
  //     .grove/server-keys.yaml (server registry). Both files are covered
  //     by the root .gitignore (.grove/ is excluded).
  {
    const { detectWorktreeName, generateApiKey, writeClientKey, appendServerKey } =
      await import("../../core/project-key.js");
    const worktreeName = await detectWorktreeName();
    const namespace = `${projectId}/${worktreeName}`;
    const apiKey = generateApiKey();
    await writeClientKey(grovePath, apiKey);
    await appendServerKey(grovePath, apiKey, namespace);
    progress(2.5 as never, `namespace ${namespace}`);
  }
```

Note: Check the existing `progress(n, ...)` call numbering in the file. If `progress()` only accepts integers, use `console.log(\`namespace ${namespace}\`)` instead of the `progress(2.5 as never, ...)` call above.

- [ ] **Step 2: Verify init still runs without errors**

```bash
cd /tmp && rm -rf grove-test-init && mkdir grove-test-init && cd grove-test-init && git init --initial-branch=main && bun run /Users/tafeng/grove/.claude/worktrees/memoized-splashing-bachman/src/cli/main.ts init test-grove 2>&1 | head -30
```

Expected: grove init completes, `.grove/api-key` and `.grove/server-keys.yaml` are created.

```bash
cat /tmp/grove-test-init/.grove/api-key
cat /tmp/grove-test-init/.grove/server-keys.yaml
```

Expected: `api-key` contains a `grv_` key; `server-keys.yaml` contains `version: 1`, the same key, and a namespace of the form `{uuid}/main`.

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/init.ts
git commit -m "feat(a3): generate namespace api-key in grove init, write to .grove/api-key + server-keys.yaml"
```

---

## Task 8: Integration Test — Two-Namespace Isolation

**Files:**
- Create: `src/server/namespace-isolation.test.ts`

- [ ] **Step 1: Write the integration test**

Create `src/server/namespace-isolation.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";

// biome-ignore lint/suspicious/noExplicitAny: test file
type Json = Record<string, any>;

const KEY_A = "grv_" + "a".repeat(64);
const KEY_B = "grv_" + "b".repeat(64);
const NS_A = "550e8400-0000-4000-8000-000000000001/worktree-a";
const NS_B = "550e8400-0000-4000-8000-000000000002/worktree-b";

const registry = new Map([
  [KEY_A, NS_A],
  [KEY_B, NS_B],
]);

describe("A3 namespace isolation", () => {
  it("key A resolves to namespace A", async () => {
    // We verify namespace isolation via the 400/401 enforcement layer,
    // since store-level isolation requires a real Nexus instance.
    // The auth layer is the enforcement point; store isolation is a consequence
    // of different zoneIds (tested in nexus integration tests).

    // This test verifies the server rejects foreign keys (which would target
    // a different namespace) and that a valid key resolves to the right namespace.
    //
    // We use a mock app that exposes c.get("namespace") on a test endpoint.
    const { Hono } = await import("hono");
    const { namespaceAuth } = await import("./middleware/namespace-auth.js");
    const { handleError } = await import("./middleware/error-handler.js");

    const app = new Hono<{ Variables: { namespace: string } }>();
    app.use("/api/*", namespaceAuth(registry));
    app.get("/api/ns", (c) => c.json({ namespace: c.get("namespace") }));
    app.onError(handleError);

    const resA = await app.request("/api/ns", {
      headers: { Authorization: `Bearer ${KEY_A}` },
    });
    expect(resA.status).toBe(200);
    expect(((await resA.json()) as Json).namespace).toBe(NS_A);

    const resB = await app.request("/api/ns", {
      headers: { Authorization: `Bearer ${KEY_B}` },
    });
    expect(resB.status).toBe(200);
    expect(((await resB.json()) as Json).namespace).toBe(NS_B);
  });

  it("request without Authorization → 400", async () => {
    const { Hono } = await import("hono");
    const { namespaceAuth } = await import("./middleware/namespace-auth.js");
    const { handleError } = await import("./middleware/error-handler.js");

    const app = new Hono<{ Variables: { namespace: string } }>();
    app.use("/api/*", namespaceAuth(registry));
    app.get("/api/ns", (c) => c.json({ ok: true }));
    app.onError(handleError);

    const res = await app.request("/api/ns");
    expect(res.status).toBe(400);
    const data = (await res.json()) as Json;
    expect(data.error.code).toBe("NAMESPACE_MISSING");
  });

  it("request with key not in registry → 401", async () => {
    const { Hono } = await import("hono");
    const { namespaceAuth } = await import("./middleware/namespace-auth.js");
    const { handleError } = await import("./middleware/error-handler.js");

    const app = new Hono<{ Variables: { namespace: string } }>();
    app.use("/api/*", namespaceAuth(registry));
    app.get("/api/ns", (c) => c.json({ ok: true }));
    app.onError(handleError);

    const res = await app.request("/api/ns", {
      headers: { Authorization: `Bearer grv_${"z".repeat(64)}` },
    });
    expect(res.status).toBe(401);
    const data = (await res.json()) as Json;
    expect(data.error.code).toBe("NAMESPACE_UNAUTHORIZED");
  });

  it("/health is exempt from auth", async () => {
    const { Hono } = await import("hono");
    const { namespaceAuth } = await import("./middleware/namespace-auth.js");

    const app = new Hono<{ Variables: { namespace: string } }>();
    app.use("/api/*", namespaceAuth(registry));
    app.get("/health", (c) => c.json({ ok: true }));

    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test**

```bash
bun test src/server/namespace-isolation.test.ts
```

Expected: All 4 tests PASS.

- [ ] **Step 3: Run full test suite to confirm no regressions**

```bash
bun test
```

Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/namespace-isolation.test.ts
git commit -m "test(a3): integration tests for namespace isolation — auth enforcement, health exemption"
```

---

## Final Checklist

After all tasks complete:

- [ ] `bun test` passes with no failures
- [ ] `bun tsc --noEmit` reports zero errors
- [ ] `grove init` creates `.grove/api-key` and `.grove/server-keys.yaml`
- [ ] `grep -r "namespace.*default" src/core/entity.ts` returns zero matches (hardcoding removed)
- [ ] `grep -r "GROVE_ZONE_ID" src/server/serve.ts` returns zero matches (env var removed)
- [ ] `grep -r "api/health" src/server/app.ts` returns zero matches (moved to `/health`)
- [ ] Two worktrees with separate keys → separate zoneIds in Nexus VFS paths (manual verify with Nexus logs)
- [ ] Close GitHub issue #290
