# A6 Stale-RV + Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface configurable retention + compaction metrics on the watch protocol shipped in #292, and ship a `WatchClient` helper that handles 410 by relisting via the A5 list→watch handshake. Closes the silent-desync gap in long-lived watches.

**Architecture:** Extend the existing in-memory `WatchHub` with monotonic eviction counters. Add a `GET /api/watch/metrics` JSON endpoint behind the existing `namespaceAuth`. Read `GROVE_WATCH_RETENTION_MS` / `GROVE_WATCH_MAX_EVENTS` at boot via a clamp utility. Build a thin (~150 LOC) `WatchClient` that drives the list→watch loop with backoff and a typed `RELIST` op so consumers can reconcile after a relist. Tests use `bun:test` and the existing `test-helpers.ts` factory.

**Tech Stack:** Bun + TypeScript, Hono routes, `bun:test`, no new external deps. SSE via the existing `ReadableStream` route handler.

**Spec:** `docs/superpowers/specs/2026-04-28-a6-stale-rv-compaction-design.md`

**Issue:** [#293](https://github.com/windoliver/grove/issues/293)

---

## File map

**New:**
- `src/core/clamp.ts` — `clampInt({raw, fallback, min, max, name})` for env-var parsing.
- `src/core/clamp.test.ts`
- `src/core/watch-client.ts` — list→watch loop with `RELIST`/`ADDED`/`MODIFIED`/`DELETED` ops, 410 relist, backoff.
- `src/core/watch-client.test.ts`
- `src/core/watch-hub.compaction.test.ts` — counter/`getCompactionStats()` unit tests.
- `src/server/watch-hub-config.ts` — `resolveWatchHubConfig(env)` boot helper.
- `src/server/watch-hub-config.test.ts`
- `src/server/watch.compaction.test.ts` — sleep-past-retention + metrics endpoint integration.
- `src/server/watch.relist.e2e.test.ts` — `WatchClient` against a real test server, the issue acceptance #2 test.

**Modified:**
- `src/core/watch-hub.ts` — add `evictedByAge` / `evictedByCapacity` counters in `KeyState`; promote `maxAgeMsPerKey` / `maxEventsPerKey` to public; add `getCompactionStats()`.
- `src/server/routes/watch.ts` — add `GET /api/watch/metrics`.
- `src/server/serve.ts` — call `resolveWatchHubConfig(process.env)` and pass to `WatchHub`.
- `docs/superpowers/specs/2026-04-27-a5-watch-protocol-design.md` — resolve "Open questions deferred" compaction entry.
- `docs/parity-matrix.md` — document retention env vars + metrics endpoint.

---

## Task 1: `clampInt` utility

**Files:**
- Create: `src/core/clamp.ts`
- Test: `src/core/clamp.test.ts`

**Why first:** Needed by `serve.ts` env-var wiring (Task 4). Pure logic, no deps — quickest red→green cycle to anchor the TDD rhythm.

- [ ] **Step 1: Write the failing test**

Create `src/core/clamp.test.ts`:

```typescript
import { describe, expect, mock, test } from "bun:test";
import { clampInt } from "./clamp.js";

describe("clampInt", () => {
  test("returns parsed value when within range", () => {
    expect(
      clampInt({ raw: "5000", fallback: 100, min: 1, max: 10_000, name: "X" }),
    ).toBe(5000);
  });

  test("returns fallback when raw is undefined", () => {
    const warn = mock(() => {});
    expect(
      clampInt({ raw: undefined, fallback: 42, min: 1, max: 100, name: "X", warn }),
    ).toBe(42);
    expect(warn.mock.calls.length).toBe(0); // unset is normal, no warn
  });

  test("returns fallback when raw is empty string", () => {
    expect(
      clampInt({ raw: "", fallback: 7, min: 1, max: 100, name: "X" }),
    ).toBe(7);
  });

  test("warns and returns fallback when raw is unparseable", () => {
    const warn = mock(() => {});
    expect(
      clampInt({ raw: "abc", fallback: 9, min: 1, max: 100, name: "Y", warn }),
    ).toBe(9);
    expect(warn.mock.calls.length).toBe(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("Y");
  });

  test("warns and returns fallback when raw is below min", () => {
    const warn = mock(() => {});
    expect(
      clampInt({ raw: "0", fallback: 10, min: 1, max: 100, name: "Z", warn }),
    ).toBe(10);
    expect(warn.mock.calls.length).toBe(1);
  });

  test("warns and returns fallback when raw is above max", () => {
    const warn = mock(() => {});
    expect(
      clampInt({ raw: "999", fallback: 10, min: 1, max: 100, name: "Z", warn }),
    ).toBe(10);
    expect(warn.mock.calls.length).toBe(1);
  });

  test("rejects fractional input", () => {
    const warn = mock(() => {});
    expect(
      clampInt({ raw: "1.5", fallback: 2, min: 1, max: 100, name: "F", warn }),
    ).toBe(2);
    expect(warn.mock.calls.length).toBe(1);
  });

  test("accepts boundary values", () => {
    expect(
      clampInt({ raw: "1", fallback: 5, min: 1, max: 100, name: "B" }),
    ).toBe(1);
    expect(
      clampInt({ raw: "100", fallback: 5, min: 1, max: 100, name: "B" }),
    ).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/clamp.test.ts`
Expected: FAIL — `Cannot find module './clamp.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/clamp.ts`:

```typescript
/**
 * Parse an integer env var with bounds. Used at server boot so a stray
 * `GROVE_WATCH_RETENTION_MS=-5` falls back to the documented default
 * instead of silently disabling retention.
 */

export interface ClampIntArgs {
  readonly raw: string | undefined;
  readonly fallback: number;
  readonly min: number;
  readonly max: number;
  readonly name: string;
  readonly warn?: (msg: string) => void;
}

export function clampInt({
  raw,
  fallback,
  min,
  max,
  name,
  warn = (msg) => console.warn(msg),
}: ClampIntArgs): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^-?[0-9]+$/.test(raw)) {
    warn(`${name}=${raw} is not an integer; using fallback ${fallback}`);
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  if (n < min || n > max) {
    warn(
      `${name}=${n} is outside [${min}, ${max}]; using fallback ${fallback}`,
    );
    return fallback;
  }
  return n;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/clamp.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/clamp.ts src/core/clamp.test.ts
git commit -m "feat(util): clampInt env-var parser for #293 retention bounds"
```

---

## Task 2: WatchHub compaction counters + `getCompactionStats()`

**Files:**
- Modify: `src/core/watch-hub.ts`
- Test: `src/core/watch-hub.compaction.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `src/core/watch-hub.compaction.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { contributionToEntity } from "./entity.js";
import type { Contribution } from "./models.js";
import { WatchHub } from "./watch-hub.js";

function fixtureContribution(cid: string): Contribution {
  return {
    cid,
    manifestVersion: 1,
    kind: "work",
    mode: "evaluation",
    summary: "fixture",
    artifacts: {},
    relations: [],
    tags: [],
    agent: { agentId: "a-1" },
    createdAt: new Date().toISOString(),
  };
}

function writeOne(hub: WatchHub, ns: string, cid: string): bigint {
  const entity = contributionToEntity(fixtureContribution(cid), ns);
  return hub.recordWrite({ kind: "Contribution", namespace: ns, op: "ADDED", entity });
}

describe("WatchHub compaction stats", () => {
  test("evictedByCapacity increments when ring exceeds maxEventsPerKey", () => {
    const hub = new WatchHub({ maxEventsPerKey: 3, maxAgeMsPerKey: 60_000 });
    for (let i = 0; i < 5; i++) writeOne(hub, "ns", `cid-${i}`);

    const stats = hub.getCompactionStats();
    expect(stats.length).toBe(1);
    expect(stats[0]?.namespace).toBe("ns");
    expect(stats[0]?.kind).toBe("Contribution");
    expect(stats[0]?.evictedByCapacity).toBe(2); // 5 writes, cap 3 → 2 evicted
    expect(stats[0]?.evictedByAge).toBe(0);
    expect(stats[0]?.currentRingSize).toBe(3);
    expect(stats[0]?.currentRv).toBe("5");
    expect(stats[0]?.oldestRv).toBe("3");
  });

  test("evictedByAge increments when events exceed maxAgeMsPerKey", () => {
    let now = 1_000_000;
    const hub = new WatchHub({
      maxEventsPerKey: 100,
      maxAgeMsPerKey: 100,
      now: () => now,
    });
    writeOne(hub, "ns", "old-1");
    writeOne(hub, "ns", "old-2");
    now += 250; // past retention
    writeOne(hub, "ns", "fresh-1");

    const stats = hub.getCompactionStats();
    expect(stats[0]?.evictedByAge).toBe(2);
    expect(stats[0]?.evictedByCapacity).toBe(0);
    expect(stats[0]?.currentRingSize).toBe(1);
    expect(stats[0]?.oldestRv).toBe("3");
    expect(stats[0]?.currentRv).toBe("3");
  });

  test("counters are monotonic across subscribe/unsubscribe", async () => {
    const hub = new WatchHub({ maxEventsPerKey: 2, maxAgeMsPerKey: 60_000 });
    for (let i = 0; i < 5; i++) writeOne(hub, "ns", `cid-${i}`);

    const ac = new AbortController();
    const iter = hub.subscribe("ns", "Contribution", 4n, ac.signal);
    for await (const _ev of iter) break; // consume one
    ac.abort();

    writeOne(hub, "ns", "cid-after");
    const stats = hub.getCompactionStats();
    // 6 writes total, cap 2 → 4 evicted
    expect(stats[0]?.evictedByCapacity).toBe(4);
  });

  test("getCompactionStats returns one entry per active (ns, kind)", () => {
    const hub = new WatchHub({ maxEventsPerKey: 5, maxAgeMsPerKey: 60_000 });
    writeOne(hub, "ns-a", "cid-a");
    writeOne(hub, "ns-b", "cid-b");
    const stats = hub.getCompactionStats();
    expect(stats.length).toBe(2);
    const namespaces = stats.map((s) => s.namespace).sort();
    expect(namespaces).toEqual(["ns-a", "ns-b"]);
  });

  test("oldestRv is '0' when ring is empty after full eviction", () => {
    let now = 1_000;
    const hub = new WatchHub({
      maxEventsPerKey: 100,
      maxAgeMsPerKey: 100,
      now: () => now,
    });
    writeOne(hub, "ns", "x");
    now += 1000;
    writeOne(hub, "ns", "y"); // triggers age eviction of x; y stays
    expect(hub.getCompactionStats()[0]?.currentRingSize).toBe(1);
    expect(hub.getCompactionStats()[0]?.oldestRv).toBe("2");
  });

  test("public maxAgeMsPerKey and maxEventsPerKey reflect constructor args", () => {
    const hub = new WatchHub({ maxAgeMsPerKey: 7777, maxEventsPerKey: 12 });
    expect(hub.maxAgeMsPerKey).toBe(7777);
    expect(hub.maxEventsPerKey).toBe(12);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/watch-hub.compaction.test.ts`
Expected: FAIL — `getCompactionStats` is not a function.

- [ ] **Step 3: Modify `src/core/watch-hub.ts`**

Replace the `KeyState` interface (around line 18) and counter-related members. Apply these edits:

a. Update `KeyState` to add counters:

```typescript
interface KeyState {
  counter: bigint;
  ring: WatchEvent[];
  insertedAt: number[];
  evictedByAge: number;
  evictedByCapacity: number;
}
```

b. Add the public `CompactionStats` interface near the top of the file (after the imports, before `WatchHubOptions`):

```typescript
export interface CompactionStats {
  readonly namespace: string;
  readonly kind: WatchKind;
  readonly evictedByAge: number;
  readonly evictedByCapacity: number;
  readonly currentRingSize: number;
  readonly oldestRv: string;
  readonly currentRv: string;
}
```

c. Promote `maxAgeMsPerKey` and `maxEventsPerKey` to public readonly. The class field declarations near line 31 become:

```typescript
readonly maxEventsPerKey: number;
readonly maxAgeMsPerKey: number;
readonly bookmarkIntervalMs: number;
readonly perClientOutboxCap: number;
private readonly now: () => number;
```

d. Update `getOrCreate` (around line 169) to initialize counters:

```typescript
private getOrCreate(key: string): KeyState {
  let s = this.state.get(key);
  if (!s) {
    s = {
      counter: 0n,
      ring: [],
      insertedAt: [],
      evictedByAge: 0,
      evictedByCapacity: 0,
    };
    this.state.set(key, s);
  }
  return s;
}
```

e. Update `trim()` (around line 178) to increment counters:

```typescript
private trim(s: KeyState): void {
  while (s.ring.length > this.maxEventsPerKey) {
    s.ring.shift();
    s.insertedAt.shift();
    s.evictedByCapacity += 1;
  }
  const cutoff = this.now() - this.maxAgeMsPerKey;
  while (s.ring.length > 0 && (s.insertedAt[0] ?? 0) < cutoff) {
    s.ring.shift();
    s.insertedAt.shift();
    s.evictedByAge += 1;
  }
}
```

f. Add `getCompactionStats()` as a new public method (after `snapshotRing` around line 163):

```typescript
/** Snapshot of compaction counters across all (ns, kind) keys. */
getCompactionStats(): readonly CompactionStats[] {
  const out: CompactionStats[] = [];
  for (const [keyStr, s] of this.state.entries()) {
    const sep = keyStr.indexOf("\x00");
    const namespace = keyStr.slice(0, sep);
    const kind = keyStr.slice(sep + 1) as WatchKind;
    const oldestRv = s.ring.length > 0 ? (s.ring[0] as WatchEvent).rv : 0n;
    out.push({
      namespace,
      kind,
      evictedByAge: s.evictedByAge,
      evictedByCapacity: s.evictedByCapacity,
      currentRingSize: s.ring.length,
      oldestRv: String(oldestRv),
      currentRv: String(s.counter),
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/watch-hub.compaction.test.ts`
Expected: PASS — 6 tests.

Also run the existing watch-hub tests to make sure nothing regressed:

Run: `bun test src/core/watch-hub.test.ts`
Expected: PASS — all existing tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/watch-hub.ts src/core/watch-hub.compaction.test.ts
git commit -m "feat(watch): compaction counters and getCompactionStats() (#293)"
```

---

## Task 3: `GET /api/watch/metrics` route

**Files:**
- Modify: `src/server/routes/watch.ts`
- Test: `src/server/watch.compaction.test.ts` (new — partial; expanded in Task 10)

- [ ] **Step 1: Write the failing test**

Create `src/server/watch.compaction.test.ts`:

```typescript
/**
 * Acceptance tests for issue #293 — server-side compaction surface.
 *   - GET /api/watch/metrics returns retention config and per-(ns,kind) counters
 *   - Namespace isolation: caller only sees their own keys
 */

import { describe, expect, test } from "bun:test";
import { createTestApp, makeManifestBody, TEST_AUTH_HEADERS } from "./test-helpers.js";

interface MetricsResponse {
  retention: { maxAgeMs: number; maxEvents: number };
  keys: Array<{
    namespace: string;
    kind: string;
    evictedByAge: number;
    evictedByCapacity: number;
    currentRingSize: number;
    oldestRv: string;
    currentRv: string;
  }>;
}

describe("GET /api/watch/metrics", () => {
  test("returns retention config from WatchHub options", async () => {
    const { app } = createTestApp({
      watchHubOptions: { maxAgeMsPerKey: 1234, maxEventsPerKey: 56 },
    });
    const res = await app.request("/api/watch/metrics", {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MetricsResponse;
    expect(body.retention.maxAgeMs).toBe(1234);
    expect(body.retention.maxEvents).toBe(56);
  });

  test("reports counters after writes within capacity", async () => {
    const { app } = createTestApp({
      watchHubOptions: { maxAgeMsPerKey: 60_000, maxEventsPerKey: 100 },
    });
    const writeRes = await app.request("/api/contributions", {
      method: "POST",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(makeManifestBody({ summary: "metrics-1" })),
    });
    expect(writeRes.status).toBe(201);

    const res = await app.request("/api/watch/metrics", {
      headers: TEST_AUTH_HEADERS,
    });
    const body = (await res.json()) as MetricsResponse;
    const key = body.keys.find((k) => k.kind === "Contribution");
    expect(key).toBeDefined();
    expect(key?.evictedByAge).toBe(0);
    expect(key?.evictedByCapacity).toBe(0);
    expect(key?.currentRingSize).toBe(1);
    expect(key?.currentRv).toBe("1");
  });

  test("requires authentication", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/watch/metrics");
    expect([400, 401]).toContain(res.status);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/server/watch.compaction.test.ts`
Expected: FAIL — route returns 404.

- [ ] **Step 3: Add the route to `src/server/routes/watch.ts`**

After the `watch.get("/watch", ...)` block (around line 285), insert the metrics route. It needs to be defined before the `export { watch }` line:

```typescript
/** GET /api/watch/metrics — retention config + per-(ns,kind) compaction stats. */
watch.get("/metrics", async (c) => {
  const namespace = c.get("namespace");
  const hub: WatchHub = c.get("deps").watchHub;
  const allStats = hub.getCompactionStats();
  // Filter to caller's namespace so namespaces don't leak each other's
  // traffic shape. The request is already authenticated by namespaceAuth.
  const keys = allStats.filter((s) => s.namespace === namespace);
  return c.json({
    retention: {
      maxAgeMs: hub.maxAgeMsPerKey,
      maxEvents: hub.maxEventsPerKey,
    },
    keys,
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/server/watch.compaction.test.ts`
Expected: PASS — 3 tests.

Also confirm existing watch tests still pass:

Run: `bun test src/server/watch`
Expected: PASS — all sibling tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/watch.ts src/server/watch.compaction.test.ts
git commit -m "feat(watch): GET /api/watch/metrics endpoint (#293)"
```

---

## Task 4: Wire `GROVE_WATCH_RETENTION_MS` / `GROVE_WATCH_MAX_EVENTS` in `serve.ts`

Refactor the boot-time `WatchHub` construction into a small testable helper so the env-var → `WatchHubOptions` mapping is unit-tested in isolation. Then call it from `serve.ts`.

**Files:**
- Create: `src/server/watch-hub-config.ts`
- Create: `src/server/watch-hub-config.test.ts`
- Modify: `src/server/serve.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/watch-hub-config.test.ts`:

```typescript
import { describe, expect, mock, test } from "bun:test";
import { resolveWatchHubConfig } from "./watch-hub-config.js";

describe("resolveWatchHubConfig", () => {
  test("returns defaults when no env vars set", () => {
    const cfg = resolveWatchHubConfig({});
    expect(cfg.maxAgeMsPerKey).toBe(300_000);
    expect(cfg.maxEventsPerKey).toBe(1024);
  });

  test("reads GROVE_WATCH_RETENTION_MS when in range", () => {
    const cfg = resolveWatchHubConfig({
      GROVE_WATCH_RETENTION_MS: "30000",
    });
    expect(cfg.maxAgeMsPerKey).toBe(30_000);
  });

  test("reads GROVE_WATCH_MAX_EVENTS when in range", () => {
    const cfg = resolveWatchHubConfig({
      GROVE_WATCH_MAX_EVENTS: "256",
    });
    expect(cfg.maxEventsPerKey).toBe(256);
  });

  test("clamps GROVE_WATCH_RETENTION_MS below min to default", () => {
    const warn = mock(() => {});
    const cfg = resolveWatchHubConfig(
      { GROVE_WATCH_RETENTION_MS: "0" },
      { warn },
    );
    expect(cfg.maxAgeMsPerKey).toBe(300_000);
    expect(warn.mock.calls.length).toBe(1);
  });

  test("clamps GROVE_WATCH_MAX_EVENTS above max to default", () => {
    const warn = mock(() => {});
    const cfg = resolveWatchHubConfig(
      { GROVE_WATCH_MAX_EVENTS: "9999999999" },
      { warn },
    );
    expect(cfg.maxEventsPerKey).toBe(1024);
    expect(warn.mock.calls.length).toBe(1);
  });

  test("rejects negative GROVE_WATCH_RETENTION_MS", () => {
    const warn = mock(() => {});
    const cfg = resolveWatchHubConfig(
      { GROVE_WATCH_RETENTION_MS: "-5" },
      { warn },
    );
    expect(cfg.maxAgeMsPerKey).toBe(300_000);
  });

  test("accepts boundary values", () => {
    const cfg = resolveWatchHubConfig({
      GROVE_WATCH_RETENTION_MS: "1000",     // min
      GROVE_WATCH_MAX_EVENTS: "1000000",    // max
    });
    expect(cfg.maxAgeMsPerKey).toBe(1000);
    expect(cfg.maxEventsPerKey).toBe(1_000_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/server/watch-hub-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/server/watch-hub-config.ts`:

```typescript
/**
 * Boot-time resolution of WatchHubOptions from environment variables.
 * Extracted from serve.ts so the env→config mapping is unit-testable
 * without standing up the full server (#293).
 */

import { clampInt } from "../core/clamp.js";
import type { WatchHubOptions } from "../core/watch-hub.js";

export interface ResolveOptions {
  readonly warn?: (msg: string) => void;
}

export function resolveWatchHubConfig(
  env: Readonly<Record<string, string | undefined>>,
  opts: ResolveOptions = {},
): Pick<WatchHubOptions, "maxAgeMsPerKey" | "maxEventsPerKey"> {
  return {
    maxAgeMsPerKey: clampInt({
      raw: env.GROVE_WATCH_RETENTION_MS,
      fallback: 300_000,
      min: 1_000,
      max: 86_400_000,
      name: "GROVE_WATCH_RETENTION_MS",
      ...(opts.warn ? { warn: opts.warn } : {}),
    }),
    maxEventsPerKey: clampInt({
      raw: env.GROVE_WATCH_MAX_EVENTS,
      fallback: 1024,
      min: 16,
      max: 1_000_000,
      name: "GROVE_WATCH_MAX_EVENTS",
      ...(opts.warn ? { warn: opts.warn } : {}),
    }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/server/watch-hub-config.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Modify `src/server/serve.ts`**

Add import at the top with the other `./` imports:

```typescript
import { resolveWatchHubConfig } from "./watch-hub-config.js";
```

Locate the `const watchHub = new WatchHub();` line (around line 217). Replace with:

```typescript
const watchHub = new WatchHub(resolveWatchHubConfig(process.env));
```

- [ ] **Step 6: Smoke-build**

Run: `bun run build` (check `package.json` for the actual script — it may be `bun run build:dist` or `bun run typecheck`).
Expected: PASS — no type errors.

If no build script exists for typechecking, run: `bun build src/server/serve.ts --target=bun --outdir=/tmp/grove-build-check`
Expected: builds without error.

- [ ] **Step 7: Commit**

```bash
git add src/server/watch-hub-config.ts src/server/watch-hub-config.test.ts src/server/serve.ts
git commit -m "feat(watch): GROVE_WATCH_RETENTION_MS/MAX_EVENTS env vars (#293)"
```

---

## Task 5: `WatchClient` — happy path (list → RELIST → ADDED)

**Files:**
- Create: `src/core/watch-client.ts`
- Test: `src/core/watch-client.test.ts`

This task ships the minimal happy path. Subsequent tasks add 410 relist (Task 6), TCP-close fast resume (Task 7), sequential `onEvent` + abort (Task 8), and terminal errors (Task 9). Keeping each task focused makes the TDD red→green cycle short.

- [ ] **Step 1: Write the failing test**

Create `src/core/watch-client.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { WatchClient, type WatchClientEvent } from "./watch-client.js";

/** Mock fetch returning canned list and watch responses. */
function makeFetch(
  list: { items: unknown[]; listResourceVersion: string },
  watchEvents: string[],
): typeof fetch {
  return (async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("/api/list")) {
      return new Response(JSON.stringify(list), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/watch")) {
      const body = watchEvents.join("");
      return new Response(body, {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

const ENTITY_A = {
  envelope: { kind: "Contribution", id: "cid-a" },
  data: { cid: "cid-a", summary: "a" },
};
const ENTITY_B = {
  envelope: { kind: "Contribution", id: "cid-b" },
  data: { cid: "cid-b", summary: "b" },
};

function sse(event: string, data: unknown, id?: string): string {
  const idLine = id ? `id: ${id}\n` : "";
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("WatchClient happy path", () => {
  test("emits RELIST for each list item then ADDED for streamed events", async () => {
    const seen: WatchClientEvent[] = [];
    const fetchImpl = makeFetch(
      { items: [ENTITY_A], listResourceVersion: "5" },
      [
        sse("ADDED", { rv: "6", kind: "Contribution", entity: ENTITY_B }, "6"),
      ],
    );
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
    });
    const ac = new AbortController();
    const running = client.run({
      onEvent: async (e) => {
        seen.push(e);
        if (seen.length === 2) ac.abort();
      },
      signal: ac.signal,
    });
    await running;

    expect(seen.length).toBe(2);
    expect(seen[0]?.op).toBe("RELIST");
    expect(seen[0]?.rv).toBe(5n);
    expect((seen[0]?.entity as { envelope: { id: string } }).envelope.id).toBe("cid-a");
    expect(seen[1]?.op).toBe("ADDED");
    expect(seen[1]?.rv).toBe(6n);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/watch-client.test.ts`
Expected: FAIL — `Cannot find module './watch-client.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/watch-client.ts`:

```typescript
/**
 * WatchClient — list→watch loop with relist on Expired (#293).
 *
 * Drives the A5 handshake (#292) and translates server SSE events into
 * a typed callback. RELIST signals "snapshot, not delta" so consumers
 * can run K8s-informer-style Replace() reconciliation.
 */

import type { WatchEntity, WatchKind } from "./watch-events.js";

export type WatchClientOp = "ADDED" | "MODIFIED" | "DELETED" | "RELIST";

export interface WatchClientEvent {
  readonly op: WatchClientOp;
  readonly rv: bigint;
  readonly kind: WatchKind;
  readonly entity: WatchEntity;
}

export interface WatchClientOptions {
  readonly baseUrl: string;
  readonly kind: WatchKind;
  readonly authHeader: string;
  readonly fetch?: typeof fetch;
  readonly backoff?: {
    readonly minMs: number;
    readonly maxMs: number;
    readonly jitter: number;
  };
}

interface ListResponse {
  readonly items: WatchEntity[];
  readonly listResourceVersion: string;
}

interface SseFrame {
  readonly id: string;
  readonly event: string;
  readonly data: unknown;
}

export class WatchClient {
  private readonly baseUrl: string;
  private readonly kind: WatchKind;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: WatchClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.kind = opts.kind;
    this.authHeader = opts.authHeader;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async run(opts: {
    onEvent: (e: WatchClientEvent) => Promise<void> | void;
    signal: AbortSignal;
  }): Promise<void> {
    const { onEvent, signal } = opts;
    while (!signal.aborted) {
      const list = await this.list(signal);
      for (const item of list.items) {
        if (signal.aborted) return;
        await onEvent({
          op: "RELIST",
          rv: BigInt(list.listResourceVersion),
          kind: this.kind,
          entity: item,
        });
      }
      const resumed = await this.streamWatch(
        BigInt(list.listResourceVersion),
        onEvent,
        signal,
      );
      if (resumed === "abort") return;
      // Future tasks: distinguish 410/503 (full relist, restart loop) from
      // TCP close (fast resume). For now any non-abort exit restarts the loop.
    }
  }

  private async list(signal: AbortSignal): Promise<ListResponse> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/list?kind=${this.kind}`,
      { headers: { Authorization: this.authHeader }, signal },
    );
    if (!res.ok) {
      throw new Error(`list failed: ${res.status}`);
    }
    return (await res.json()) as ListResponse;
  }

  private async streamWatch(
    fromRv: bigint,
    onEvent: (e: WatchClientEvent) => Promise<void> | void,
    signal: AbortSignal,
  ): Promise<"abort" | "ended"> {
    const url = `${this.baseUrl}/api/watch?kind=${this.kind}&resumeFrom=${fromRv}`;
    const res = await this.fetchImpl(url, {
      headers: { Authorization: this.authHeader, Accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) return "ended";

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) return "ended";
        buf += decoder.decode(value, { stream: true });
        let idx = buf.indexOf("\n\n");
        while (idx >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const frame = parseSseFrame(block);
          if (frame && isDataOp(frame.event)) {
            const payload = frame.data as { rv: string; entity: WatchEntity };
            await onEvent({
              op: frame.event as WatchClientOp,
              rv: BigInt(payload.rv),
              kind: this.kind,
              entity: payload.entity,
            });
          }
          if (signal.aborted) return "abort";
          idx = buf.indexOf("\n\n");
        }
      }
      return "abort";
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already cancelled */
      }
    }
  }
}

function parseSseFrame(block: string): SseFrame | null {
  const id = /^id: (.*)$/m.exec(block)?.[1] ?? "";
  const event = /^event: (.*)$/m.exec(block)?.[1] ?? "";
  const dataLine = /^data: (.*)$/m.exec(block)?.[1] ?? "null";
  if (!event) return null;
  let data: unknown = null;
  try {
    data = JSON.parse(dataLine);
  } catch {
    data = dataLine;
  }
  return { id, event, data };
}

function isDataOp(event: string): boolean {
  return event === "ADDED" || event === "MODIFIED" || event === "DELETED";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/watch-client.test.ts`
Expected: PASS — 1 test.

- [ ] **Step 5: Commit**

```bash
git add src/core/watch-client.ts src/core/watch-client.test.ts
git commit -m "feat(watch): WatchClient happy path — list→RELIST→ADDED (#293)"
```

---

## Task 6: `WatchClient` — 410/503 relist with backoff

**Files:**
- Modify: `src/core/watch-client.ts`
- Modify: `src/core/watch-client.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `src/core/watch-client.test.ts`:

```typescript
/**
 * Helper: chained fetch that returns scripted responses in order. Each call
 * matches a (urlPattern, body) pair. Throws if the script runs out.
 */
function scriptedFetch(
  steps: Array<{ urlPattern: string; body: string; status?: number; json?: unknown }>,
): typeof fetch {
  let i = 0;
  return (async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (i >= steps.length) {
      throw new Error(`scripted fetch exhausted at ${url}`);
    }
    const step = steps[i] as (typeof steps)[number];
    i += 1;
    if (!url.includes(step.urlPattern)) {
      throw new Error(
        `expected url to contain ${step.urlPattern}, got ${url}`,
      );
    }
    if (step.json !== undefined) {
      return new Response(JSON.stringify(step.json), {
        status: step.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(step.body, {
      status: step.status ?? 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;
}

describe("WatchClient relist on 410", () => {
  test("ERROR{code:410} triggers relist + new RELIST events", async () => {
    const seen: WatchClientEvent[] = [];
    const fetchImpl = scriptedFetch([
      // First list
      { urlPattern: "/api/list", json: { items: [ENTITY_A], listResourceVersion: "5" } },
      // First watch — emits 410 immediately
      {
        urlPattern: "/api/watch",
        body: sse("ERROR", { code: 410, reason: "expired" }, "5"),
      },
      // Second list (relist)
      { urlPattern: "/api/list", json: { items: [ENTITY_B], listResourceVersion: "10" } },
      // Second watch — empty stream, then closes
      { urlPattern: "/api/watch", body: "" },
    ]);
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    const ac = new AbortController();
    const running = client.run({
      onEvent: async (e) => {
        seen.push(e);
        // Stop after we observe the second relist.
        const relists = seen.filter((s) => s.op === "RELIST");
        if (relists.length >= 2) ac.abort();
      },
      signal: ac.signal,
    });
    await running;

    const relists = seen.filter((s) => s.op === "RELIST");
    expect(relists.length).toBe(2);
    expect((relists[0]?.entity as { envelope: { id: string } }).envelope.id).toBe("cid-a");
    expect((relists[1]?.entity as { envelope: { id: string } }).envelope.id).toBe("cid-b");
    expect(relists[1]?.rv).toBe(10n);
  });

  test("ERROR{code:503} triggers relist same as 410", async () => {
    const seen: WatchClientEvent[] = [];
    const fetchImpl = scriptedFetch([
      { urlPattern: "/api/list", json: { items: [ENTITY_A], listResourceVersion: "5" } },
      {
        urlPattern: "/api/watch",
        body: sse("ERROR", { code: 503, reason: "buffer_overflow" }, "5"),
      },
      { urlPattern: "/api/list", json: { items: [ENTITY_B], listResourceVersion: "9" } },
      { urlPattern: "/api/watch", body: "" },
    ]);
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    const ac = new AbortController();
    const running = client.run({
      onEvent: async (e) => {
        seen.push(e);
        const relists = seen.filter((s) => s.op === "RELIST");
        if (relists.length >= 2) ac.abort();
      },
      signal: ac.signal,
    });
    await running;
    expect(seen.filter((s) => s.op === "RELIST").length).toBe(2);
  });

  test("backoff sleeps between attempts when minMs > 0", async () => {
    const sleeps: number[] = [];
    const fetchImpl = scriptedFetch([
      { urlPattern: "/api/list", json: { items: [], listResourceVersion: "0" } },
      { urlPattern: "/api/watch", body: sse("ERROR", { code: 410 }, "0") },
      { urlPattern: "/api/list", json: { items: [], listResourceVersion: "0" } },
      { urlPattern: "/api/watch", body: sse("ERROR", { code: 410 }, "0") },
      { urlPattern: "/api/list", json: { items: [], listResourceVersion: "0" } },
      { urlPattern: "/api/watch", body: sse("ERROR", { code: 410 }, "0") },
      { urlPattern: "/api/list", json: { items: [], listResourceVersion: "0" } },
      { urlPattern: "/api/watch", body: "" },
    ]);
    const ac = new AbortController();
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 10, maxMs: 100, jitter: 0 },
    });
    // Hook the internal sleep via Bun's Date.now/setTimeout? Easier: snapshot
    // wall-clock times around restarts. Use a custom sleep injection point:
    // (handled by exposing onBackoff in implementation step below)
    (client as unknown as { onBackoff?: (ms: number) => void }).onBackoff = (
      ms: number,
    ) => {
      sleeps.push(ms);
      if (sleeps.length >= 3) ac.abort();
    };
    await client.run({ onEvent: () => {}, signal: ac.signal });
    expect(sleeps).toEqual([10, 20, 40]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/watch-client.test.ts`
Expected: FAIL — relist tests see only one RELIST or hit "scripted fetch exhausted"; backoff test sees no sleeps.

- [ ] **Step 3: Modify `src/core/watch-client.ts`**

Add backoff state and the ERROR-frame branch. The full updated file:

```typescript
/**
 * WatchClient — list→watch loop with relist on Expired (#293).
 *
 * Drives the A5 handshake (#292) and translates server SSE events into
 * a typed callback. RELIST signals "snapshot, not delta" so consumers
 * can run K8s-informer-style Replace() reconciliation.
 */

import type { WatchEntity, WatchKind } from "./watch-events.js";

export type WatchClientOp = "ADDED" | "MODIFIED" | "DELETED" | "RELIST";

export interface WatchClientEvent {
  readonly op: WatchClientOp;
  readonly rv: bigint;
  readonly kind: WatchKind;
  readonly entity: WatchEntity;
}

export interface WatchClientOptions {
  readonly baseUrl: string;
  readonly kind: WatchKind;
  readonly authHeader: string;
  readonly fetch?: typeof fetch;
  readonly backoff?: {
    readonly minMs: number;
    readonly maxMs: number;
    readonly jitter: number;
  };
}

const DEFAULT_BACKOFF = { minMs: 100, maxMs: 30_000, jitter: 0.3 };

interface ListResponse {
  readonly items: WatchEntity[];
  readonly listResourceVersion: string;
}

interface SseFrame {
  readonly id: string;
  readonly event: string;
  readonly data: unknown;
}

type StreamExit =
  | { kind: "abort" }
  | { kind: "ended" }
  | { kind: "relist" }; // 410/503 → full relist

export class WatchClient {
  private readonly baseUrl: string;
  private readonly kind: WatchKind;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly backoffCfg: NonNullable<WatchClientOptions["backoff"]>;
  /** Test-only hook called whenever the loop sleeps for `ms` after a failure. */
  onBackoff?: (ms: number) => void;

  constructor(opts: WatchClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.kind = opts.kind;
    this.authHeader = opts.authHeader;
    this.fetchImpl = opts.fetch ?? fetch;
    this.backoffCfg = opts.backoff ?? DEFAULT_BACKOFF;
  }

  async run(opts: {
    onEvent: (e: WatchClientEvent) => Promise<void> | void;
    signal: AbortSignal;
  }): Promise<void> {
    const { onEvent, signal } = opts;
    let nextDelay = this.backoffCfg.minMs;
    while (!signal.aborted) {
      const list = await this.list(signal);
      for (const item of list.items) {
        if (signal.aborted) return;
        await onEvent({
          op: "RELIST",
          rv: BigInt(list.listResourceVersion),
          kind: this.kind,
          entity: item,
        });
      }
      // Successful list → reset backoff.
      nextDelay = this.backoffCfg.minMs;
      const exit = await this.streamWatch(
        BigInt(list.listResourceVersion),
        onEvent,
        signal,
      );
      if (exit.kind === "abort") return;
      if (exit.kind === "relist") {
        // 410/503 — backoff, then restart with a fresh list.
        await this.sleep(nextDelay, signal);
        nextDelay = this.advanceBackoff(nextDelay);
        continue;
      }
      // exit.kind === "ended" — no error event, stream just closed. Reopen
      // immediately with the same fromRv (no relist needed). For now restart
      // the loop; Task 7 introduces fast-resume.
      await this.sleep(nextDelay, signal);
      nextDelay = this.advanceBackoff(nextDelay);
    }
  }

  private async list(signal: AbortSignal): Promise<ListResponse> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/list?kind=${this.kind}`,
      { headers: { Authorization: this.authHeader }, signal },
    );
    if (!res.ok) {
      throw new Error(`list failed: ${res.status}`);
    }
    return (await res.json()) as ListResponse;
  }

  private async streamWatch(
    fromRv: bigint,
    onEvent: (e: WatchClientEvent) => Promise<void> | void,
    signal: AbortSignal,
  ): Promise<StreamExit> {
    const url = `${this.baseUrl}/api/watch?kind=${this.kind}&resumeFrom=${fromRv}`;
    const res = await this.fetchImpl(url, {
      headers: { Authorization: this.authHeader, Accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) return { kind: "ended" };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) return { kind: "ended" };
        buf += decoder.decode(value, { stream: true });
        let idx = buf.indexOf("\n\n");
        while (idx >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const frame = parseSseFrame(block);
          if (!frame) {
            idx = buf.indexOf("\n\n");
            continue;
          }
          if (frame.event === "ERROR") {
            const code = (frame.data as { code?: number })?.code;
            if (code === 410 || code === 503) return { kind: "relist" };
            throw new Error(`watch terminal error: code=${code}`);
          }
          if (isDataOp(frame.event)) {
            const payload = frame.data as { rv: string; entity: WatchEntity };
            await onEvent({
              op: frame.event as WatchClientOp,
              rv: BigInt(payload.rv),
              kind: this.kind,
              entity: payload.entity,
            });
          }
          if (signal.aborted) return { kind: "abort" };
          idx = buf.indexOf("\n\n");
        }
      }
      return { kind: "abort" };
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already cancelled */
      }
    }
  }

  private advanceBackoff(prev: number): number {
    const doubled = Math.min(this.backoffCfg.maxMs, Math.max(this.backoffCfg.minMs, prev * 2));
    return doubled;
  }

  private async sleep(ms: number, signal: AbortSignal): Promise<void> {
    this.onBackoff?.(ms);
    if (ms <= 0 || signal.aborted) return;
    const jitter = this.backoffCfg.jitter;
    const actual =
      jitter > 0 ? ms * (1 + (Math.random() * 2 - 1) * jitter) : ms;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, actual);
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function parseSseFrame(block: string): SseFrame | null {
  const id = /^id: (.*)$/m.exec(block)?.[1] ?? "";
  const event = /^event: (.*)$/m.exec(block)?.[1] ?? "";
  const dataLine = /^data: (.*)$/m.exec(block)?.[1] ?? "null";
  if (!event) return null;
  let data: unknown = null;
  try {
    data = JSON.parse(dataLine);
  } catch {
    data = dataLine;
  }
  return { id, event, data };
}

function isDataOp(event: string): boolean {
  return event === "ADDED" || event === "MODIFIED" || event === "DELETED";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/watch-client.test.ts`
Expected: PASS — 4 tests (1 from Task 5 + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/core/watch-client.ts src/core/watch-client.test.ts
git commit -m "feat(watch): WatchClient relist on 410/503 with backoff (#293)"
```

---

## Task 7: `WatchClient` — fast resume on TCP close

**Files:**
- Modify: `src/core/watch-client.ts`
- Modify: `src/core/watch-client.test.ts`

The "ended" exit path currently falls back to a full relist. Per spec, a TCP close without an ERROR event should fast-resume from the last-seen rv (or the listRv if no events were seen yet) — no fresh list needed.

- [ ] **Step 1: Append failing tests**

Append to `src/core/watch-client.test.ts`:

```typescript
describe("WatchClient fast resume on TCP close", () => {
  test("reopens watch from last-seen rv after stream ends without ERROR", async () => {
    const seen: WatchClientEvent[] = [];
    const watchUrls: string[] = [];
    const ac = new AbortController();
    const fetchImpl = ((async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/api/list")) {
        return new Response(
          JSON.stringify({ items: [], listResourceVersion: "5" }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/watch")) {
        watchUrls.push(url);
        if (watchUrls.length === 1) {
          // First watch: emit ADDED rv=6 then end.
          return new Response(
            sse("ADDED", { rv: "6", kind: "Contribution", entity: ENTITY_A }, "6"),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        }
        // Second watch observed → fire abort so the loop unwinds. Returning
        // an empty body would otherwise spin the loop forever (no onEvent
        // fires to drive an in-callback abort).
        ac.abort();
        return new Response("", {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch);
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    const running = client.run({
      onEvent: async (e) => {
        seen.push(e);
      },
      signal: ac.signal,
    });
    await running;

    expect(watchUrls.length).toBeGreaterThanOrEqual(2);
    // First watch resumes from listRv=5; second resumes from last-seen rv=6.
    expect(watchUrls[0]).toContain("resumeFrom=5");
    expect(watchUrls[1]).toContain("resumeFrom=6");
    expect(seen.filter((e) => e.op === "RELIST").length).toBe(0); // no relist
  });

  test("first ended-without-event uses listRv as resumeFrom", async () => {
    const watchUrls: string[] = [];
    const fetchImpl = ((async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/api/list")) {
        return new Response(
          JSON.stringify({ items: [], listResourceVersion: "5" }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/watch")) {
        watchUrls.push(url);
        return new Response("", {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch);
    const ac = new AbortController();
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    const running = client.run({
      onEvent: () => {},
      signal: ac.signal,
    });
    // Let it loop a few times then abort.
    setTimeout(() => ac.abort(), 50);
    await running;

    expect(watchUrls.length).toBeGreaterThanOrEqual(2);
    for (const u of watchUrls) {
      expect(u).toContain("resumeFrom=5");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/watch-client.test.ts`
Expected: FAIL — first new test sees `resumeFrom=5` for both watches (no fast resume); RELIST count is non-zero because the loop currently re-lists on `ended`.

- [ ] **Step 3: Modify the loop in `src/core/watch-client.ts`**

Track `lastSeenRv` inside the `run()` loop. Replace the `run()` method body and `streamWatch()` signature so the watch reports the last rv it observed.

a. Update `StreamExit`:

```typescript
type StreamExit =
  | { kind: "abort" }
  | { kind: "ended"; lastRv: bigint }
  | { kind: "relist" };
```

b. Update `streamWatch` to track and return `lastRv`:

```typescript
private async streamWatch(
  fromRv: bigint,
  onEvent: (e: WatchClientEvent) => Promise<void> | void,
  signal: AbortSignal,
): Promise<StreamExit> {
  let lastRv = fromRv;
  const url = `${this.baseUrl}/api/watch?kind=${this.kind}&resumeFrom=${fromRv}`;
  const res = await this.fetchImpl(url, {
    headers: { Authorization: this.authHeader, Accept: "text/event-stream" },
    signal,
  });
  if (!res.ok || !res.body) return { kind: "ended", lastRv };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) return { kind: "ended", lastRv };
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf("\n\n");
      while (idx >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const frame = parseSseFrame(block);
        if (!frame) {
          idx = buf.indexOf("\n\n");
          continue;
        }
        if (frame.event === "ERROR") {
          const code = (frame.data as { code?: number })?.code;
          if (code === 410 || code === 503) return { kind: "relist" };
          throw new Error(`watch terminal error: code=${code}`);
        }
        if (isDataOp(frame.event)) {
          const payload = frame.data as { rv: string; entity: WatchEntity };
          const rv = BigInt(payload.rv);
          lastRv = rv;
          await onEvent({
            op: frame.event as WatchClientOp,
            rv,
            kind: this.kind,
            entity: payload.entity,
          });
        } else if (frame.event === "BOOKMARK") {
          // BOOKMARK advances resume cursor without firing onEvent.
          const rv = (frame.data as { rv?: string })?.rv;
          if (rv && /^[0-9]+$/.test(rv)) lastRv = BigInt(rv);
        }
        if (signal.aborted) return { kind: "abort" };
        idx = buf.indexOf("\n\n");
      }
    }
    return { kind: "abort" };
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already cancelled */
    }
  }
}
```

c. Replace the `run()` body to thread `lastRv` through fast-resume:

```typescript
async run(opts: {
  onEvent: (e: WatchClientEvent) => Promise<void> | void;
  signal: AbortSignal;
}): Promise<void> {
  const { onEvent, signal } = opts;
  let nextDelay = this.backoffCfg.minMs;
  let resumeFrom: bigint | null = null; // null → must (re)list

  while (!signal.aborted) {
    if (resumeFrom === null) {
      const list = await this.list(signal);
      for (const item of list.items) {
        if (signal.aborted) return;
        await onEvent({
          op: "RELIST",
          rv: BigInt(list.listResourceVersion),
          kind: this.kind,
          entity: item,
        });
      }
      resumeFrom = BigInt(list.listResourceVersion);
      nextDelay = this.backoffCfg.minMs;
    }
    const exit = await this.streamWatch(resumeFrom, onEvent, signal);
    if (exit.kind === "abort") return;
    if (exit.kind === "relist") {
      // Full relist on next iteration.
      resumeFrom = null;
      await this.sleep(nextDelay, signal);
      nextDelay = this.advanceBackoff(nextDelay);
      continue;
    }
    // exit.kind === "ended" — fast resume from lastRv.
    resumeFrom = exit.lastRv;
    await this.sleep(nextDelay, signal);
    nextDelay = this.advanceBackoff(nextDelay);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/watch-client.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/watch-client.ts src/core/watch-client.test.ts
git commit -m "feat(watch): WatchClient fast resume on TCP close (#293)"
```

---

## Task 8: `WatchClient` — sequential `onEvent` + abort during in-flight callback

**Files:**
- Modify: `src/core/watch-client.test.ts` (only — implementation already satisfies these contracts; tests assert and lock them in)

- [ ] **Step 1: Append failing tests**

Append to `src/core/watch-client.test.ts`:

```typescript
describe("WatchClient onEvent semantics", () => {
  test("awaits each onEvent before processing the next", async () => {
    const order: string[] = [];
    let resolveFirst: (() => void) | undefined;
    const firstDone = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const fetchImpl = makeFetch(
      { items: [], listResourceVersion: "5" },
      [
        sse("ADDED", { rv: "6", kind: "Contribution", entity: ENTITY_A }, "6"),
        sse("ADDED", { rv: "7", kind: "Contribution", entity: ENTITY_B }, "7"),
      ],
    );
    const ac = new AbortController();
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    const running = client.run({
      onEvent: async (e) => {
        order.push(`enter:${e.rv}`);
        if (e.rv === 6n) await firstDone;
        order.push(`exit:${e.rv}`);
        if (e.rv === 7n) ac.abort();
      },
      signal: ac.signal,
    });
    // Give the loop a tick to enter onEvent for rv=6.
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["enter:6"]);
    resolveFirst?.();
    await running;
    expect(order).toEqual(["enter:6", "exit:6", "enter:7", "exit:7"]);
  });

  test("abort during in-flight onEvent waits for callback to settle", async () => {
    let callbackResolved = false;
    let onEventEntered = false;
    const fetchImpl = makeFetch(
      { items: [ENTITY_A], listResourceVersion: "5" },
      [],
    );
    const ac = new AbortController();
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    const running = client.run({
      onEvent: async () => {
        onEventEntered = true;
        ac.abort(); // abort while we are inside onEvent
        await new Promise((r) => setTimeout(r, 20));
        callbackResolved = true;
      },
      signal: ac.signal,
    });
    await running;
    expect(onEventEntered).toBe(true);
    expect(callbackResolved).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

The current `run()` already `await`s every `onEvent` before checking `signal.aborted`, so these tests should pass without code changes. Run: `bun test src/core/watch-client.test.ts`
Expected: PASS — 8 tests.

If any test fails, the `await onEvent(...)` call sites in `streamWatch` and the `RELIST` loop need a closer audit — but the implementation from Task 7 already awaits sequentially.

- [ ] **Step 3: Commit**

```bash
git add src/core/watch-client.test.ts
git commit -m "test(watch): WatchClient sequential onEvent + abort semantics (#293)"
```

---

## Task 9: `WatchClient` — terminal errors (401/501/malformed SSE)

**Files:**
- Modify: `src/core/watch-client.ts`
- Modify: `src/core/watch-client.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `src/core/watch-client.test.ts`:

```typescript
describe("WatchClient terminal errors", () => {
  test("rejects on HTTP 401 from list", async () => {
    const fetchImpl = ((async () =>
      new Response(JSON.stringify({ code: "UNAUTHENTICATED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch);
    const ac = new AbortController();
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    await expect(
      client.run({ onEvent: () => {}, signal: ac.signal }),
    ).rejects.toThrow(/401|UNAUTHENTICATED|list failed/);
  });

  test("rejects on watch ERROR with non-410/503 code", async () => {
    const fetchImpl = scriptedFetch([
      { urlPattern: "/api/list", json: { items: [], listResourceVersion: "0" } },
      {
        urlPattern: "/api/watch",
        body: sse("ERROR", { code: 400, reason: "validation_error" }, "0"),
      },
    ]);
    const ac = new AbortController();
    const client = new WatchClient({
      baseUrl: "http://t",
      kind: "Contribution",
      authHeader: "Bearer x",
      fetch: fetchImpl,
      backoff: { minMs: 0, maxMs: 0, jitter: 0 },
    });
    await expect(
      client.run({ onEvent: () => {}, signal: ac.signal }),
    ).rejects.toThrow(/400|terminal/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `bun test src/core/watch-client.test.ts`
Expected: from the implementation in Task 6:
  - The 401 test should already PASS (`list()` throws on `!res.ok`).
  - The non-410/503 ERROR test should already PASS (the `streamWatch` ERROR branch throws).

If both pass without changes, skip Step 3 and go straight to commit.

- [ ] **Step 3: If a test fails, harden the relevant branch**

For 401: confirm `this.list()` throws and that the throw bubbles out of `run()`. Already covered.

For non-410 ERROR: confirm the `throw new Error("watch terminal error...")` in `streamWatch` propagates. Already covered.

If both pass, no implementation change needed.

- [ ] **Step 4: Commit**

```bash
git add src/core/watch-client.test.ts
git commit -m "test(watch): WatchClient terminal error contracts (#293)"
```

---

## Task 10: Server compaction integration test (sleep past retention)

**Files:**
- Modify: `src/server/watch.compaction.test.ts`

- [ ] **Step 1: Append the sleep-past-retention test**

Append to `src/server/watch.compaction.test.ts`:

```typescript
import { readSseEvents } from "./sse-test-utils.js";

describe("compaction triggers Expired (issue #293 acceptance #1)", () => {
  test("sleep past retention window → resume returns 410", async () => {
    let now = 1_000_000;
    const { app } = createTestApp({
      watchHubOptions: {
        maxAgeMsPerKey: 200,
        maxEventsPerKey: 100,
        now: () => now,
      },
    });

    // Capture rv before any writes so it falls strictly below the post-
    // eviction oldestRv. With earlyRv=0 and oldestRv=2 after eviction,
    // the 410 trigger `fromRv < oldestRv - 1n` (0 < 1) holds.
    const earlyRv = await listRv(app);
    expect(earlyRv).toBe("0");

    const writeRes1 = await app.request("/api/contributions", {
      method: "POST",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(makeManifestBody({ summary: "early" })),
    });
    expect(writeRes1.status).toBe(201);

    // Advance clock past retention so the next write's trim evicts entry 1.
    now += 1_000;

    const writeRes2 = await app.request("/api/contributions", {
      method: "POST",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(makeManifestBody({ summary: "late" })),
    });
    expect(writeRes2.status).toBe(201);

    // Resume from earlyRv=0. Ring oldestRv=2 → 410.
    const watchRes = await app.request(
      `/api/watch?kind=Contribution&resumeFrom=${earlyRv}`,
      { headers: TEST_AUTH_HEADERS },
    );
    const events = await readSseEvents(watchRes, 1, 1_000);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const errorEvent = events.find((e) => e.event === "ERROR");
    expect(errorEvent).toBeDefined();
    expect((errorEvent?.data as { code: number }).code).toBe(410);
    expect((errorEvent?.data as { reason: string }).reason).toBe("expired");

    // Metrics endpoint reflects the eviction.
    const metricsRes = await app.request("/api/watch/metrics", {
      headers: TEST_AUTH_HEADERS,
    });
    const metrics = (await metricsRes.json()) as MetricsResponse;
    const key = metrics.keys.find((k) => k.kind === "Contribution");
    expect(key?.evictedByAge).toBeGreaterThanOrEqual(1);
  });

  test("capacity-based eviction also returns 410", async () => {
    const { app } = createTestApp({
      watchHubOptions: { maxAgeMsPerKey: 60_000, maxEventsPerKey: 4 },
    });
    const earlyRv = await listRv(app);
    for (let i = 0; i < 10; i++) {
      const r = await app.request("/api/contributions", {
        method: "POST",
        headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify(makeManifestBody({ summary: `cap-${i}` })),
      });
      expect(r.status).toBe(201);
    }
    const watchRes = await app.request(
      `/api/watch?kind=Contribution&resumeFrom=${earlyRv}`,
      { headers: TEST_AUTH_HEADERS },
    );
    const events = await readSseEvents(watchRes, 1, 1_000);
    const errorEvent = events.find((e) => e.event === "ERROR");
    expect(errorEvent).toBeDefined();
    expect((errorEvent?.data as { code: number }).code).toBe(410);

    const metricsRes = await app.request("/api/watch/metrics", {
      headers: TEST_AUTH_HEADERS,
    });
    const metrics = (await metricsRes.json()) as MetricsResponse;
    const key = metrics.keys.find((k) => k.kind === "Contribution");
    expect(key?.evictedByCapacity).toBeGreaterThanOrEqual(1);
  });
});

async function listRv(app: { request: (path: string, init?: RequestInit) => Promise<Response> }): Promise<string> {
  const res = await app.request("/api/list?kind=Contribution", {
    headers: TEST_AUTH_HEADERS,
  });
  const json = (await res.json()) as { listResourceVersion: string };
  return json.listResourceVersion;
}
```

Note: the new imports (`readSseEvents`) go alongside the existing imports at the top of the file. Drop the `contributionToEntity` import shown in the snippet above — it is not used by the test body.

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test src/server/watch.compaction.test.ts`
Expected: PASS — all tests including the new acceptance ones.

If the sleep test fails because the server route is using `Date.now()` rather than the injected `now`, double-check that `WatchHub` constructor is being threaded with `opts.watchHubOptions.now` in `test-helpers.ts` (it already is, per existing source).

- [ ] **Step 3: Commit**

```bash
git add src/server/watch.compaction.test.ts
git commit -m "test(watch): sleep-past-retention + capacity eviction (#293 #1)"
```

---

## Task 11: E2E relist test — `WatchClient` against in-process server

**Files:**
- Create: `src/server/watch.relist.e2e.test.ts`

This is the issue acceptance criterion #2: client relists via A5 handshake automatically → no events missed across the gap.

- [ ] **Step 1: Write the failing test**

Create `src/server/watch.relist.e2e.test.ts`:

```typescript
/**
 * Acceptance test for issue #293 — criterion #2.
 *
 * A WatchClient driven against a real in-process grove-server that has
 * a tiny ring buffer survives a simulated kill -9 + sleep past retention
 * by relisting via the A5 handshake. Every contribution surfaces (via
 * either RELIST or ADDED) with no missed entities.
 *
 * Sizing: maxEventsPerKey=2 + 5 writes during pause guarantees
 * `oldestRv >= lastSeenRv + 2`, which is the condition the server uses to
 * raise StaleResourceVersionError. (See WatchHub.subscribe: trigger is
 * `fromRv < oldestRv - 1n`.)
 */

import { describe, expect, test } from "bun:test";
import { WatchClient, type WatchClientEvent } from "../core/watch-client.js";
import type { ContributionEntity } from "../core/entity.js";
import { createTestApp, makeManifestBody, TEST_AUTH_HEADERS } from "./test-helpers.js";

describe("WatchClient survives retention gap (issue #293 acceptance #2)", () => {
  test("client relists across retention gap with no missed events", async () => {
    let now = 1_000_000;
    const { app } = createTestApp({
      watchHubOptions: {
        maxAgeMsPerKey: 60_000,  // age not the trigger; capacity is
        maxEventsPerKey: 2,
        now: () => now,
      },
    });

    // app.request is a Hono helper that turns a path + RequestInit into a
    // Response. WatchClient expects a base URL + WHATWG fetch. Adapt by
    // intercepting the URL prefix and forwarding to app.request.
    const adaptedFetch: typeof fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const path = url.replace(/^http:\/\/test/, "");
      return app.request(path, init);
    }) as typeof fetch;

    const seen: WatchClientEvent[] = [];
    const ac = new AbortController();
    let paused = false;
    const pauseGate: typeof fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (paused && url.includes("/api/watch")) {
        // Simulate disconnect: return 503 so streamWatch sees !res.ok and ends.
        return new Response("", { status: 503 });
      }
      return adaptedFetch(input, init);
    }) as typeof fetch;

    const client = new WatchClient({
      baseUrl: "http://test",
      kind: "Contribution",
      authHeader: TEST_AUTH_HEADERS.Authorization as string,
      fetch: pauseGate,
      backoff: { minMs: 5, maxMs: 50, jitter: 0 },
    });

    const running = client.run({
      onEvent: async (e) => {
        seen.push(e);
      },
      signal: ac.signal,
    });

    // Helper to write a contribution with a known summary marker.
    const post = async (marker: string): Promise<void> => {
      const r = await app.request("/api/contributions", {
        method: "POST",
        headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify(makeManifestBody({ summary: marker })),
      });
      expect(r.status).toBe(201);
    };

    // Phase 1: write 3 events and wait for the watcher to ack all 3.
    for (const m of ["m1", "m2", "m3"]) await post(m);
    await waitFor(
      () => seen.filter((e) => e.op === "ADDED").length >= 3,
      2_000,
    );

    // Phase 2: pause + write 5 more so capacity eviction pushes
    // oldestRv past the client's last-seen rv.
    paused = true;
    await sleep(50); // let the loop see 503 and enter backoff
    for (const m of ["m4", "m5", "m6", "m7", "m8"]) await post(m);

    // Phase 3: resume. Next watch attempt hits 410 (lastSeenRv=3 is
    // outside the ring whose oldestRv is 7), which forces a relist.
    paused = false;

    await waitFor(() => {
      const summaries = collectSummaries(seen);
      return (
        seen.some((e) => e.op === "RELIST") &&
        ["m4", "m5", "m6", "m7", "m8"].some((m) => summaries.has(m))
      );
    }, 5_000);

    ac.abort();
    await running;

    // Every marker is observed at least once across the run.
    const observed = collectSummaries(seen);
    for (const m of ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"]) {
      expect(observed.has(m)).toBe(true);
    }
    expect(seen.some((e) => e.op === "RELIST")).toBe(true);
  }, 15_000);
});

function collectSummaries(events: readonly WatchClientEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    const summary = (e.entity as ContributionEntity).spec?.summary;
    if (summary) out.add(summary);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error("waitFor timed out");
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test src/server/watch.relist.e2e.test.ts`
Expected: PASS — 1 test (within 15s timeout).

If the test times out: log `seen.map(e => ({op: e.op, rv: e.rv.toString(), summary: (e.entity as ContributionEntity).spec?.summary}))` before the assertions to confirm the relist is happening. Common causes:
- pause/unpause timing — increase `await sleep(50)` if the loop is still mid-list when `paused=true`.
- `bigint` JSON serialization — the existing watch route already stringifies rv on the wire; only the client converts back via `BigInt(...)`.

- [ ] **Step 3: Commit**

```bash
git add src/server/watch.relist.e2e.test.ts
git commit -m "test(watch): WatchClient relist E2E across retention gap (#293 #2)"
```

---

## Task 12: Update docs

**Files:**
- Modify: `docs/superpowers/specs/2026-04-27-a5-watch-protocol-design.md`
- Modify: `docs/parity-matrix.md`

- [ ] **Step 1: Update the A5 spec deferred-questions section**

In `docs/superpowers/specs/2026-04-27-a5-watch-protocol-design.md`, find the "Open questions deferred" section near the end. Replace the bullet:

```markdown
- Compaction window for ring buffers when a kind sees a sustained burst >
  cap. A6 (#293) addresses this; A5's behavior is "drop oldest, return 410
  on stale resume."
```

with:

```markdown
- ~~Compaction window for ring buffers when a kind sees a sustained burst >
  cap.~~ Addressed by A6 (#293) — see
  `docs/superpowers/specs/2026-04-28-a6-stale-rv-compaction-design.md`.
```

- [ ] **Step 2: Add a row to `docs/parity-matrix.md`**

Open `docs/parity-matrix.md` and add a new row to the appropriate table. The exact section depends on the matrix's current structure — read the file first. Add (or extend an existing "Watch" section with):

```markdown
| Watch retention | server-side ring buffer | `GROVE_WATCH_RETENTION_MS` (default 300000), `GROVE_WATCH_MAX_EVENTS` (default 1024). Stale resume returns SSE `event:ERROR data:{code:410, reason:"expired"}`. Clients re-list via A5 handshake. Per-`(ns,kind)` compaction stats at `GET /api/watch/metrics`. See `docs/superpowers/specs/2026-04-28-a6-stale-rv-compaction-design.md`. |
```

If the matrix is row-per-(capability, local, nexus) instead of free-form, populate columns to match. If unsure of the table format, read the existing rows first and follow the pattern.

- [ ] **Step 3: Verify nothing else is missed**

Run a quick grep to make sure no remaining placeholder language refers to compaction as deferred:

```bash
grep -rn "compaction.*A6\|compaction.*deferred\|compaction.*future\|TODO.*compaction" docs/
```

Expected: only matches in this design doc and the updated A5 spec entry pointing forward.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-04-27-a5-watch-protocol-design.md docs/parity-matrix.md
git commit -m "docs(watch): document #293 retention env vars + metrics endpoint"
```

---

## Final verification

- [ ] **Run the full test suite**

Run: `bun test`
Expected: PASS — all suites green. If anything outside `src/core/watch-*` or `src/server/watch*` fails, revisit Task 4 (env-var wiring may have introduced a stray import that broke a sibling test).

- [ ] **Manual smoke**

If a working server-up command exists in the repo (e.g., `bun run dev` or `grove up`), do a manual sanity check:

```bash
GROVE_WATCH_RETENTION_MS=5000 bun run src/server/serve.ts &
sleep 1
# Substitute your auth token + URL.
curl -s "http://localhost:8080/api/watch/metrics" -H "Authorization: Bearer $TOKEN" | jq .
# Expected: {"retention":{"maxAgeMs":5000,"maxEvents":1024},"keys":[]}
```

If `bun run dev` doesn't exist or requires Nexus to be up, skip this step — the integration + E2E tests already cover the behavior.

- [ ] **Self-review checklist**

Before opening the PR, eyeball the diff:
- All new files are under `src/core/` or `src/server/` and follow existing naming.
- No `console.log` left over from debugging the E2E test.
- The `WatchClient` import in the E2E test is from `../core/watch-client.js` (with `.js` extension — TypeScript NodeNext convention used in the repo).
- The `getCompactionStats()` snapshot is non-mutating (returns a new array; callers can't push into hub state).

---

## Acceptance traceability

| Issue criterion | Where covered |
|-----------------|---------------|
| Sleep past retention window → resume returns `Expired` | Task 10 (`watch.compaction.test.ts`) |
| Client relists via A5 handshake automatically → no events missed | Task 11 (`watch.relist.e2e.test.ts`) |
| Retention window configurable + documented | Tasks 4 + 12 |
| Compaction metric exposed | Tasks 2 + 3 (`getCompactionStats()` + `/api/watch/metrics`) |
