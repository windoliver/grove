# TUI Session Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resume a selected TUI session with its full linked contribution history and existing historical trace buffers.

**Architecture:** Add a provider-level `getSessionContributions(sessionId)` contract and implement it for store-backed, remote HTTP, and Nexus providers. Add a dedicated `GET /api/sessions/:id/contributions` route so remote resume is not limited by `/api/contributions` pagination caps. Make `RunningView` use this session-history path whenever it has a `sessionId`, while preserving the existing live refresh path and trace loading behavior.

**Tech Stack:** Bun 1.3.x, TypeScript strict mode, Hono server routes, bun:test, Biome.

---

## File Map

- `src/tui/provider.ts`: extend `TuiSessionProvider` with `getSessionContributions`.
- `src/tui/provider-shared.ts`: add ordered batch-loading helper and HTTP helper for session contributions.
- `src/tui/provider-shared.test.ts`: test ordered batch-loading helper.
- `src/tui/store-backed-provider.ts`: implement session history for local/store-backed providers.
- `src/server/routes/sessions.ts`: add `GET /api/sessions/:id/contributions`.
- `src/server/routes/sessions.test.ts`: route regression for more than 100 linked contributions in link order.
- `src/tui/remote-provider.ts`: implement remote session history via HTTP helper.
- `src/tui/remote-provider.test.ts`: verify remote provider calls the dedicated route.
- `src/tui/nexus-provider.ts`: prefer server route when available, otherwise read Nexus session links and batch-load from the contribution store.
- `src/tui/nexus-provider.test.ts`: verify Nexus fallback reads all linked contributions from Nexus.
- `src/tui/screens/running-view.tsx`: route the contribution fetcher through session history when `sessionId` is set.
- `src/tui/screens/running-view-session-history.test.ts`: pure tests for `RunningView` contribution fetch routing.

---

### Task 1: Provider Contract and Ordered Batch Helper

**Files:**
- Modify: `src/tui/provider.ts`
- Modify: `src/tui/provider-shared.ts`
- Modify: `src/tui/provider-shared.test.ts`
- Modify: `src/tui/store-backed-provider.ts`

- [ ] **Step 1: Write the failing provider-shared helper test**

In `src/tui/provider-shared.test.ts`, update the imports:

```ts
import {
  activityFromStore,
  archiveSessionHttp,
  claimsFromStore,
  contributionDetailFromStore,
  contributionsForCidsInOrder,
  dagFromStore,
  dashboardFromStores,
  diffArtifactsFromBuffers,
  HttpConflictError,
  outcomeStatsFromStore,
  setGoalHttp,
} from "./provider-shared.js";
```

In `makeMockContributionStore`, add `getMany` after `get`:

```ts
getMany: async (cids: readonly string[]) => {
  const result = new Map<string, Contribution>();
  for (const cid of cids) {
    const contribution = contributions.find((c) => c.cid === cid);
    if (contribution !== undefined) result.set(cid, contribution);
  }
  return result;
},
```

Add this test inside `describe("provider-shared", () => { ... })`:

```ts
describe("contributionsForCidsInOrder", () => {
  test("batch-loads contributions and preserves requested CID order", async () => {
    const first = makeContribution({ cid: "blake3:first" });
    const second = makeContribution({ cid: "blake3:second" });
    const third = makeContribution({ cid: "blake3:third" });
    const store = makeMockContributionStore([first, second, third]);

    const result = await contributionsForCidsInOrder(store, [
      "blake3:third",
      "blake3:first",
      "blake3:missing",
      "blake3:second",
    ]);

    expect(result.map((c) => c.cid)).toEqual(["blake3:third", "blake3:first", "blake3:second"]);
  });
});
```

- [ ] **Step 2: Run the helper test to verify it fails**

Run:

```bash
bun test src/tui/provider-shared.test.ts --test-name-pattern contributionsForCidsInOrder
```

Expected: FAIL with an export error for `contributionsForCidsInOrder`.

- [ ] **Step 3: Add the shared ordered batch helper**

In `src/tui/provider-shared.ts`, add this near the contribution helpers:

```ts
/** Batch-load contributions by CID while preserving the requested CID order. */
export async function contributionsForCidsInOrder(
  store: ContributionStore,
  cids: readonly string[],
): Promise<readonly Contribution[]> {
  if (cids.length === 0) return [];

  const byCid = await store.getMany(cids);
  const ordered: Contribution[] = [];
  for (const cid of cids) {
    const contribution = byCid.get(cid);
    if (contribution !== undefined) ordered.push(contribution);
  }
  return ordered;
}
```

- [ ] **Step 4: Extend the TUI session provider contract**

In `src/tui/provider.ts`, add this method to `TuiSessionProvider` after `getSession`:

```ts
  /** Return all contributions linked to a session, preserving session history order. */
  getSessionContributions(sessionId: string): Promise<readonly Contribution[]>;
```

- [ ] **Step 5: Implement store-backed session history**

In `src/tui/store-backed-provider.ts`, add `contributionsForCidsInOrder` to the provider-shared imports:

```ts
  contributionsForCidsInOrder,
```

Add this method near the other `TuiSessionProvider` methods:

```ts
  /** Return all contributions linked to a session, preserving session link order. */
  async getSessionContributions(sessionId: string): Promise<readonly Contribution[]> {
    if (!this.goalSession) return [];
    const cids = await this.goalSession.getSessionContributions(sessionId);
    return contributionsForCidsInOrder(this.store, cids);
  }
```

- [ ] **Step 6: Run the focused helper test**

Run:

```bash
bun test src/tui/provider-shared.test.ts --test-name-pattern contributionsForCidsInOrder
```

Expected: PASS.

- [ ] **Step 7: Run typecheck to expose remaining provider implementations**

Run:

```bash
bun run typecheck
```

Expected: FAIL because `RemoteDataProvider` does not yet satisfy the extended `TuiSessionProvider` contract.

- [ ] **Step 8: Commit Task 1**

```bash
git add src/tui/provider.ts src/tui/provider-shared.ts src/tui/provider-shared.test.ts src/tui/store-backed-provider.ts
git commit -m "feat(tui): add session contribution history provider contract (#184)"
```

---

### Task 2: Server Route and Remote HTTP Provider

**Files:**
- Modify: `src/server/routes/sessions.ts`
- Modify: `src/server/routes/sessions.test.ts`
- Modify: `src/tui/provider-shared.ts`
- Modify: `src/tui/remote-provider.ts`
- Modify: `src/tui/remote-provider.test.ts`

- [ ] **Step 1: Write the failing server route test**

In `src/server/routes/sessions.test.ts`, add imports:

```ts
import type { Contribution } from "../../core/models.js";
```

Add these helpers near the test store:

```ts
function cidForIndex(index: number): string {
  return `blake3:${index.toString(16).padStart(64, "0")}`;
}

function makeRouteContribution(index: number): Contribution {
  return {
    cid: cidForIndex(index),
    manifestVersion: 1,
    kind: "work",
    mode: "evaluation",
    summary: `session contribution ${index}`,
    tags: [],
    artifacts: {},
    relations: [],
    agent: { agentId: "agent-1" },
    createdAt: new Date(1_700_000_000_000 + index).toISOString(),
  };
}
```

Add this test inside `describe("session routes", () => { ... })`:

```ts
test("GET /api/sessions/:id/contributions returns all linked contributions in session order", async () => {
  const goalSessionStore = new TestGoalSessionStore();
  const session = await goalSessionStore.createSession({ goal: "history" });
  const { app, contributionStore } = createTestApp({ goalSessionStore });

  const contributions = Array.from({ length: 125 }, (_, i) => makeRouteContribution(i + 1));
  for (const contribution of contributions) {
    await contributionStore.put(contribution);
  }
  for (const contribution of contributions.toReversed()) {
    await goalSessionStore.addContributionToSession(session.id, contribution.cid);
  }

  const res = await app.request(`/api/sessions/${session.id}/contributions`, {
    headers: TEST_AUTH_HEADERS,
  });

  expect(res.status).toBe(200);
  const body = (await res.json()) as readonly Contribution[];
  expect(body.length).toBe(125);
  expect(body.map((c) => c.cid)).toEqual(contributions.toReversed().map((c) => c.cid));
});
```

- [ ] **Step 2: Run the server route test to verify it fails**

Run:

```bash
bun test src/server/routes/sessions.test.ts --test-name-pattern "GET /api/sessions/:id/contributions returns all linked contributions"
```

Expected: FAIL with HTTP 404 or an unexpected response shape.

- [ ] **Step 3: Add the session contributions route**

In `src/server/routes/sessions.ts`, update the import from `./shared.js`:

```ts
import { contributionStoreForSession, notConfigured, readJsonBody } from "./shared.js";
```

The import is already present; keep it and add no duplicate import. Add this route after `GET /api/sessions/:id` and before the delete route:

```ts
/** GET /api/sessions/:id/contributions — Full contribution history for a session. */
sessions.get("/:id/contributions", async (c) => {
  const deps = c.get("deps");
  const { goalSessionStore } = deps;
  if (!goalSessionStore) return notConfigured(c, "Goal/session store is not configured");

  const sessionId = c.req.param("id");
  const session = await goalSessionStore.getSession(sessionId);
  if (!session) {
    return c.json(
      { error: { code: "NOT_FOUND", message: `Session not found: ${sessionId}` } },
      404,
    );
  }

  const cids = await goalSessionStore.getSessionContributions(sessionId);
  if (cids.length === 0) return c.json([]);

  const contributionStore = contributionStoreForSession(deps, sessionId);
  const byCid = await contributionStore.getMany(cids);
  const contributions: Contribution[] = [];
  for (const cid of cids) {
    const contribution = byCid.get(cid);
    if (contribution !== undefined) contributions.push(contribution);
  }

  return c.json(contributions);
});
```

- [ ] **Step 4: Run the server route test to verify it passes**

Run:

```bash
bun test src/server/routes/sessions.test.ts --test-name-pattern "GET /api/sessions/:id/contributions returns all linked contributions"
```

Expected: PASS.

- [ ] **Step 5: Add the HTTP helper test through RemoteDataProvider**

In `src/tui/remote-provider.test.ts`, add this test near the existing scoped session tests:

```ts
test("getSessionContributions uses the dedicated session history route", async () => {
  const requestedPaths: string[] = [];
  const contribution = { manifestVersion: 1, ...makeContribution({ summary: "history item" }) };
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requestedPaths.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/api/sessions/session-1/contributions") {
        return Response.json([contribution]);
      }
      return new Response("not found", { status: 404 });
    },
  });

  try {
    const provider = new RemoteDataProvider(`http://localhost:${server.port}`);
    const result = await provider.getSessionContributions("session-1");

    expect(result.map((c) => c.cid)).toEqual([contribution.cid]);
  } finally {
    server.stop(true);
  }

  expect(requestedPaths).toEqual(["/api/sessions/session-1/contributions"]);
});
```

- [ ] **Step 6: Run the remote provider test to verify it fails**

Run:

```bash
bun test src/tui/remote-provider.test.ts --test-name-pattern "getSessionContributions uses the dedicated session history route"
```

Expected: FAIL because `RemoteDataProvider.getSessionContributions` is not implemented.

- [ ] **Step 7: Add the shared HTTP helper**

In `src/tui/provider-shared.ts`, add this import:

```ts
import { parseContributions } from "../core/schemas.js";
```

Add this helper near the other session HTTP helpers:

```ts
/** Fetch full contribution history for a session via grove-server HTTP API. */
export async function getSessionContributionsHttp(
  baseUrl: string,
  sessionId: string,
  authHeaders?: Record<string, string>,
): Promise<readonly Contribution[]> {
  const resp = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/contributions`, {
    headers: authHeaders,
  });
  if (resp.ok) return parseContributions(await resp.json());
  if (resp.status === 404) return [];
  throw new Error(`Failed to fetch session contributions: HTTP ${String(resp.status)}`);
}
```

- [ ] **Step 8: Implement RemoteDataProvider session history**

In `src/tui/remote-provider.ts`, add `getSessionContributionsHttp` to the provider-shared imports:

```ts
  getSessionContributionsHttp,
```

Add this method near the other `TuiSessionProvider` methods:

```ts
  async getSessionContributions(sessionId: string): Promise<readonly Contribution[]> {
    return getSessionContributionsHttp(this.baseUrl, sessionId, this.authHeaders);
  }
```

- [ ] **Step 9: Run server and remote tests**

Run:

```bash
bun test src/server/routes/sessions.test.ts --test-name-pattern "GET /api/sessions/:id/contributions returns all linked contributions"
bun test src/tui/remote-provider.test.ts --test-name-pattern "getSessionContributions uses the dedicated session history route"
```

Expected: both PASS.

- [ ] **Step 10: Commit Task 2**

```bash
git add src/server/routes/sessions.ts src/server/routes/sessions.test.ts src/tui/provider-shared.ts src/tui/remote-provider.ts src/tui/remote-provider.test.ts
git commit -m "feat(server): expose session contribution history (#184)"
```

---

### Task 3: Nexus Provider Session History

**Files:**
- Modify: `src/tui/nexus-provider.ts`
- Modify: `src/tui/nexus-provider.test.ts`

- [ ] **Step 1: Write the failing Nexus fallback test**

In `src/tui/nexus-provider.test.ts`, add imports:

```ts
import type { Contribution } from "../core/models.js";
import { NexusContributionStore } from "../nexus/nexus-contribution-store.js";
import { NexusSessionStore } from "../nexus/nexus-session-store.js";
```

Add helpers near the mock workspace helper:

```ts
function makeNexusContribution(cid: string, summary: string): Contribution {
  return {
    cid,
    manifestVersion: 1,
    kind: "work",
    mode: "evaluation",
    summary,
    tags: [],
    artifacts: {},
    relations: [],
    agent: { agentId: "agent-1" },
    createdAt: new Date().toISOString(),
  };
}
```

Add this test inside `describe("NexusDataProvider lifecycle", () => { ... })`:

```ts
test("getSessionContributions reads Nexus session links without a co-located server", async () => {
  const client = new MockNexusClient();
  const contributionStore = new NexusContributionStore({ client, zoneId: "zone-1" });
  const sessionStore = new NexusSessionStore(client, "zone-1");
  const first = makeNexusContribution(
    "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "first",
  );
  const second = makeNexusContribution(
    "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "second",
  );
  await contributionStore.put(first);
  await contributionStore.put(second);
  const session = await sessionStore.createSession({ goal: "nexus history" });
  await sessionStore.addContribution(session.id, second.cid);
  await sessionStore.addContribution(session.id, first.cid);

  const provider = new NexusDataProvider({
    nexusConfig: { client, zoneId: "zone-1" },
  });

  const result = await provider.getSessionContributions(session.id);

  expect(result.map((c) => c.cid)).toEqual([second.cid, first.cid]);
});
```

- [ ] **Step 2: Run the Nexus fallback test to verify it fails**

Run:

```bash
bun test src/tui/nexus-provider.test.ts --test-name-pattern "getSessionContributions reads Nexus session links"
```

Expected: FAIL because `NexusDataProvider` inherits the store-backed method, which has no `goalSessionStore` in this setup and returns an empty list.

- [ ] **Step 3: Implement NexusDataProvider session history**

In `src/tui/nexus-provider.ts`, add imports:

```ts
  contributionsForCidsInOrder,
  getSessionContributionsHttp,
```

Add this override near `getSession` and `addContributionToSession`:

```ts
  override async getSessionContributions(sessionId: string): Promise<readonly Contribution[]> {
    if (this.serverUrl) {
      try {
        return await getSessionContributionsHttp(this.serverUrl, sessionId, this.authHeaders);
      } catch {
        /* fall through to Nexus VFS */
      }
    }
    const cids = await this.nexusSessionStore.getContributions(sessionId);
    return contributionsForCidsInOrder(this.store, cids);
  }
```

- [ ] **Step 4: Run the Nexus fallback test to verify it passes**

Run:

```bash
bun test src/tui/nexus-provider.test.ts --test-name-pattern "getSessionContributions reads Nexus session links"
```

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS for provider interface coverage. If unrelated existing errors appear, record the first unrelated file and continue only after confirming it predates this work.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/tui/nexus-provider.ts src/tui/nexus-provider.test.ts
git commit -m "feat(tui): load Nexus session contribution history (#184)"
```

---

### Task 4: RunningView Uses Session History on Resume

**Files:**
- Modify: `src/tui/screens/running-view.tsx`
- Create: `src/tui/screens/running-view-session-history.test.ts`

- [ ] **Step 1: Write the failing RunningView fetch-routing tests**

Create `src/tui/screens/running-view-session-history.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { Contribution } from "../../core/models.js";
import type { TuiDataProvider, TuiSessionProvider } from "../provider.js";
import { fetchRunningContributions } from "./running-view.js";

function contribution(cid: string, summary: string): Contribution {
  return {
    cid,
    manifestVersion: 1,
    kind: "work",
    mode: "evaluation",
    summary,
    tags: [],
    artifacts: {},
    relations: [],
    agent: { agentId: "agent-1" },
    createdAt: new Date().toISOString(),
  };
}

function baseCapabilities(sessions: boolean) {
  return {
    outcomes: false,
    artifacts: false,
    vfs: false,
    messaging: false,
    costTracking: false,
    askUser: false,
    github: false,
    bounties: false,
    gossip: false,
    goals: false,
    sessions,
    handoffs: false,
  };
}

describe("fetchRunningContributions", () => {
  test("uses full session contribution history when a session id is present", async () => {
    const sessionHistory = [contribution("blake3:session", "session")];
    const liveList = [contribution("blake3:live", "live")];
    const calls: string[] = [];
    const provider = {
      capabilities: baseCapabilities(true),
      getContributions: async () => {
        calls.push("getContributions");
        return liveList;
      },
      getSessionContributions: async (sessionId: string) => {
        calls.push(`getSessionContributions:${sessionId}`);
        return sessionHistory;
      },
    } as unknown as TuiDataProvider & TuiSessionProvider;

    const result = await fetchRunningContributions(provider, "session-1");

    expect(result).toEqual(sessionHistory);
    expect(calls).toEqual(["getSessionContributions:session-1"]);
  });

  test("uses normal contribution list when no session id is present", async () => {
    const liveList = [contribution("blake3:live", "live")];
    const calls: string[] = [];
    const provider = {
      capabilities: baseCapabilities(true),
      getContributions: async () => {
        calls.push("getContributions");
        return liveList;
      },
      getSessionContributions: async () => {
        calls.push("getSessionContributions");
        return [];
      },
    } as unknown as TuiDataProvider & TuiSessionProvider;

    const result = await fetchRunningContributions(provider, undefined);

    expect(result).toEqual(liveList);
    expect(calls).toEqual(["getContributions"]);
  });
});
```

- [ ] **Step 2: Run the RunningView fetch-routing tests to verify they fail**

Run:

```bash
bun test src/tui/screens/running-view-session-history.test.ts
```

Expected: FAIL because `fetchRunningContributions` is not exported.

- [ ] **Step 3: Add the fetch helper and route RunningView through it**

In `src/tui/screens/running-view.tsx`, update the provider import:

```ts
import type { DashboardData, TuiDataProvider } from "../provider.js";
import { isHandoffProvider, isSessionProvider, isVfsProvider } from "../provider.js";
```

Add this exported helper immediately before the `RunningView` component export:

```ts
export async function fetchRunningContributions(
  provider: TuiDataProvider,
  sessionId: string | undefined,
): Promise<readonly Contribution[]> {
  if (sessionId !== undefined && isSessionProvider(provider)) {
    return provider.getSessionContributions(sessionId);
  }
  return provider.getContributions();
}
```

Change the contribution fetcher:

```ts
    const contributionsFetcher = useCallback(async () => {
      fetchCountRef.current++;
      const result = await fetchRunningContributions(provider, sessionId);
      debugLog("feed.fetch", `total=${result?.length ?? 0}`);
      if (fetchCountRef.current <= 5 || fetchCountRef.current % 20 === 0) {
        debugLog(
          "poll",
          `fetch #${fetchCountRef.current} returned ${result?.length ?? 0} contributions`,
        );
      }
      return result;
    }, [provider, sessionId]);
```

- [ ] **Step 4: Run the RunningView fetch-routing tests to verify they pass**

Run:

```bash
bun test src/tui/screens/running-view-session-history.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run targeted RunningView and screen-manager tests**

Run:

```bash
bun test src/tui/screens/running-view-session-history.test.ts
bun test src/tui/screens/screen-manager.test.ts --test-name-pattern "resumed grove starts on running"
```

Expected: PASS. This verifies selected-session scope still reaches `RunningView`; trace loading is already covered by the existing `spawnManager.loadTraces(sessionId)` path in `ScreenManager`.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/tui/screens/running-view.tsx src/tui/screens/running-view-session-history.test.ts
git commit -m "feat(tui): use session history for resumed feed (#184)"
```

---

### Task 5: Full Verification

**Files:**
- No new source files.

- [ ] **Step 1: Run all focused tests for this feature**

Run:

```bash
bun test \
  src/tui/provider-shared.test.ts \
  src/server/routes/sessions.test.ts \
  src/tui/remote-provider.test.ts \
  src/tui/nexus-provider.test.ts \
  src/tui/screens/running-view-session-history.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run trace persistence regression tests**

Run:

```bash
bun test src/tui/data/trace-persistence.test.ts src/tui/data/agent-log-buffer.test.ts
```

Expected: PASS. These tests verify loaded trace JSONL lines remain historical and live lines are not marked historical.

- [ ] **Step 3: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run Biome check**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 5: Run the full test suite if the focused commands pass**

Run:

```bash
bun test
```

Expected: PASS. If an unrelated flaky or environment-dependent test fails, capture its exact name and output before deciding whether to isolate it.

- [ ] **Step 6: Final commit if verification required formatting-only fixes**

If Task 5 required any code or formatting fixes, commit them:

```bash
git add src/tui/provider.ts src/tui/provider-shared.ts src/tui/provider-shared.test.ts src/tui/store-backed-provider.ts src/server/routes/sessions.ts src/server/routes/sessions.test.ts src/tui/remote-provider.ts src/tui/remote-provider.test.ts src/tui/nexus-provider.ts src/tui/nexus-provider.test.ts src/tui/screens/running-view.tsx src/tui/screens/running-view-session-history.test.ts
git commit -m "test(tui): verify session replay on resume (#184)"
```

If Task 5 required no changes, do not create an empty commit.
