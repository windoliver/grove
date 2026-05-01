# A8 — PR2 (Entity-backed view migration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the `usePolledData` *call sites* that read directly from the three Entity kinds (`Contribution`, `Claim`, `AgentSession`) to the informer-backed hooks shipped in PR1 (#387). Wire local-mode plumbing (factory `listFn` + `WatchHub.recordWrite`) so those hooks actually deliver events when the user is not connected to grove-server. Wrap the interactive `tui-app.tsx` render path so the eager InformerProvider is in scope by the time a migrated view mounts.

**Architecture:** PR1 already extracted the `WatchStream` interface, built `LocalWatchClient`, added the discriminated-union `InformerFactory` with `mode: "remote" | "local"`, and shipped `<InformerProvider>` + `useEntities` / `useEntity` / `useDerived`. PR1 left every `usePolledData` caller untouched and constructed the factory only in remote mode (with `eager=false`). PR2 takes the next step: flip `eager` on once the first hook consumer mounts, construct the factory in local mode, wire the local stores' write path into `hub.recordWrite`, and swap each Entity-backed view to the new hook. `usePolledData` itself stays in tree — non-Entity callers don't migrate until PR4, deletion is PR5.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), Bun test runner (`bun:test`), React (OpenTUI, no DOM), existing `WatchHub` / `WatchClient` / `LocalWatchClient` / `Informer` from `src/core/`, the PR1 hook bundle in `src/tui/hooks/`.

**Spec:** `docs/superpowers/specs/2026-04-30-retire-polling-a8-design.md` §Migration plan PR2. Issue #388. Depends on #387 (closed). Parent epic #295.

**Out of scope for PR2:**
- Cross-kind aggregates (`useDerived` over multiple kinds) — that is PR3 (#389): `dag.tsx`, `dashboard.tsx`, frontier projections, agent-graph layout when it composes claims+sessions live, panel-manager cross-kind context.
- Non-Entity sources (vfs, terminal output, gossip, threads, bounties, outcomes, decisions, GitHub PR, search beyond cache) — PR4 (#390).
- `setInterval` removal in `src/tui/main.ts` — PR5 (#391).
- Deletion of `usePolledData` / `usePanelState` / old `useRefreshContext` — PR5.
- Server-side AgentSession `/api/list` + `/api/watch` routes — currently 501. PR2 ships AgentSession migration in **local mode only**; in remote mode AgentSession views fall back to the existing polling path. See AgentSession scope decision below.

---

## AgentSession scope decision

The spec calls for migrating the AgentSession portions of `agent-list.tsx`, `pipeline-view.tsx`, and `agent-graph.tsx` in PR2. The factory in PR1 deliberately excludes AgentSession from `SUPPORTED_KINDS` (the comment on `informer.ts:329` notes the grove-server `/api/list` route returns 501 NOT_CONFIGURED for it). That gate is mode-agnostic today.

**Decision (recorded here, not negotiable mid-implementation):**

1. PR2 splits `SUPPORTED_KINDS` per mode. Remote: `["Contribution", "Claim"]` (unchanged behavior). Local: `["Contribution", "Claim", "AgentSession"]`.
2. Local mode adds an AgentSession `listFn` projection — driven by `appProps.agentRuntime.listSessions()` (returns `readonly AgentSession[]`) + `agentSessionToEntity`.
3. Local mode adds AgentSession `recordWrite` calls at the runtime boundary (`AcpxRuntime` / wrapper) when sessions transition state — minimum: spawn → `ADDED`, status change → `MODIFIED`, close → `DELETED`.
4. Migrated views call `useEntities("AgentSession", …)`. The hook surfaces a `factory.supportsKind(kind)` check; when remote-mode factories don't support it, the hook returns `{ data: undefined, hasSynced: false, error: null }` and the view code falls back to a local non-reactive shape (today: tmux session list, which is *not* an AgentSession projection). The view keeps a small per-mode branch so non-migrated remote consumers don't regress.

**Why not defer AgentSession entirely to PR3?** The spec migration table explicitly assigns AgentSession to PR2. PR3 is reserved for cross-kind aggregates (`useDerived`), not single-kind reads. Splitting AgentSession off would either bloat PR3 or create a half-migrated view layer where the Claim portion of `agent-list.tsx` is reactive but the session portion still polls. Better to land the local-mode path in PR2 and add server support in a follow-up that is *not* on the A8 critical path.

**Why not just enable AgentSession in remote mode too?** The grove-server `/api/list?kind=AgentSession` route returns 501. Enabling it in `SUPPORTED_KINDS` would surface 4xx noise via `factory.addErrorListener` and leave consumers stuck at `hasSynced=false`. The 501 is a server-side gap (#287 follow-up), not a TUI defect to paper over.

If during implementation it turns out that no view actually needs the AgentSession entity (i.e. the tmux session list polling is sufficient and the spec's table was aspirational), record that finding under Task 9 and exit AgentSession migration with no view-side change.

---

## File structure

**New files:**

| Path | Responsibility |
|---|---|
| `src/local/watch-hub-recorder.ts` | Helper that wraps a `WatchHub` and exposes typed `recordContribution(op, c)` / `recordClaim(op, c)` / `recordAgentSession(op, s)` methods. Encapsulates the entity projection (`contributionToEntity` / `claimToEntity` / `agentSessionToEntity`) and namespace plumbing so callers don't repeat the boilerplate. |
| `src/local/watch-hub-recorder.test.ts` | Unit tests: each `record*` method emits the expected `EntityWriteEvent` with correct kind/op/namespace/projection. |
| `src/tui/views/claims.test.tsx` | Smoke test — mount with seeded informer, publish Claim event, assert re-render. |
| `src/tui/views/agent-list.test.tsx` | Smoke test — mount with seeded informer, publish Claim event, assert re-render. (Session portion fallback covered by mode-branch unit tests when AgentSession factory absent.) |
| `src/tui/views/pipeline-view.entity.test.ts` | Smoke test for the Claim+session projection through the new hook. (Existing `pipeline-view.test.ts` covers the pure `buildPipeline` helper — keep it.) |
| `src/tui/views/agent-graph.test.tsx` | Smoke test — mount, publish Claim event, assert layout recompute. |
| `src/tui/views/activity.test.tsx` | Smoke test — mount with seeded Contribution informer, publish event, assert re-render. |
| `src/tui/views/activity-panel.test.tsx` | Smoke test. |
| `src/tui/views/search-panel.entity.test.ts` | Smoke test for the in-cache (no-query) path through `useEntities("Contribution", …)`. The full-text-search path stays on `usePolledData` until PR4. |
| `src/tui/views/detail.test.tsx` | Smoke test for `useEntity("Contribution", id)`. |
| `src/tui/panels/panel-manager.entity.test.ts` | Smoke test for the `useEntity("Contribution", detailCid)` lookup that resolves artifact names. |

**Modified files:**

| Path | Change |
|---|---|
| `src/core/informer.ts` | Split `SUPPORTED_KINDS` per mode. Add `factory.supportsKind(kind: WatchKind): boolean`. Add `factory.mode` getter. `informerFor` throws only when the kind is unsupported by the *constructed* mode. |
| `src/core/informer.test.ts` | Add coverage for per-mode `SUPPORTED_KINDS` + `supportsKind` + `informerFor` throw on unsupported kind. |
| `src/local/runtime.ts` | Optional opt-in `watchHub` field on `LocalRuntimeOptions` and `LocalRuntime`. When provided, the runtime forwards Entity writes via `WatchHubRecorder`. Existing callers (CLI, server) leave `watchHub` undefined → no behavior change. |
| `src/local/sqlite-store.ts` | Add `onEntityWrite` callback hook on `SqliteContributionStore` and `SqliteClaimStore` (mirrors the existing `onWrite` pattern). Each successful write fires the callback with the projected `EntityWriteEvent`. Default no-op preserves backwards compatibility. |
| `src/core/agent-runtime.ts` (or its concrete impl) | Optional `onSessionWrite(event: EntityWriteEvent)` hook called on spawn/close/status-change. Default no-op. |
| `src/tui/main.ts` | Construct a process-local `WatchHub` once (only in local mode; remote mode keeps the server-side hub via WatchClient). Pass `watchHub` into `createLocalRuntime`. Build the local-mode `InformerFactory` with `listFn` projecting from the runtime stores + agent runtime. Pass `eager=true` to `<InformerProviderHolder>` (was implicit `false` in PR1). Same for the legacy `--url` direct-render path. |
| `src/tui/views/claims.tsx` | `usePolledData(getClaims)` → `useEntities("Claim", c => c.status.phase === "active")`. Map `ClaimEntity` back to the row shape (drop the entity envelope at the row layer, not the hook layer — keeps the rest of the view untouched). |
| `src/tui/views/agent-list.tsx` | Replace the claim fetcher with `useEntities("Claim", …)`. Replace the session-portion polling (`tmux.listSessions()`) with `useEntities("AgentSession", …)` *gated* on `factory.supportsKind("AgentSession")`; remote-mode keeps the existing tmux poller. Keep the cost fetcher on `usePolledData` (non-Entity → PR4). |
| `src/tui/views/pipeline-view.tsx` | Same dual: `useEntities("Claim", …)` always; `useEntities("AgentSession", …)` when supported, tmux poller fallback otherwise. Outputs (`tmux.capturePanes`) stay on `usePolledData` — PR4. |
| `src/tui/views/agent-graph.tsx` | Same dual. The dynamic-edge `buildDynamicEdges` derivation stays — PR3 will lift it into `useDerived` when the dashboard cross-cuts migrate. |
| `src/tui/views/activity.tsx` | `usePolledData(getActivity)` → `useEntities("Contribution", c => /* slice by pageOffset/pageSize */)`. Sort by `creationTimestamp` desc. Note: activity is a *recent* feed; for now `useEntities` returns the full informer cache filtered + sliced — if the cache exceeds the page bounds, paging works without re-fetch. The "load more" flow that fetches beyond the cache stays on `usePolledData` (PR4 covers full-text/beyond-cache cases). |
| `src/tui/views/activity-panel.tsx` | `usePolledData(getActivity({ limit: 30 }))` → `useEntities("Contribution", …)` with a `.slice(0, 30)`. |
| `src/tui/views/search-panel.tsx` | When `searchQuery === ""` and `hasSearch === false` (the "showing recent contributions" branch): `useEntities("Contribution", …)`. The full-text-search branches (`searchQuery !== ""` with `hasSearch`) stay on `usePolledData` — PR4. |
| `src/tui/views/detail.tsx` | `usePolledData(getContribution(cid))` → `useEntity("Contribution", cid)` for the contribution body. The outcome fetcher stays on `usePolledData` — non-Entity. The ancestors / children / thread shape needs `getContribution` for the relation graph (PR3 follow-up); for PR2, keep the existing `getContribution` polling for those fields and let `useEntity` drive only the *primary* contribution body (whose updates were the source of staleness today). |
| `src/tui/panels/panel-manager.tsx` | Replace the inline `usePolledData(getContribution(detailCid))` (used only to resolve artifact names) with `useEntity("Contribution", detailCid)`. |

**Untouched in PR2:**

- `src/tui/views/dag.tsx`, `src/tui/views/dashboard.tsx`, `src/tui/views/frontier-view.tsx`, `src/tui/views/handoffs-view.tsx`, `src/tui/views/threads-panel.tsx`, `src/tui/views/inbox-panel.tsx`, `src/tui/views/decisions-panel.tsx`, `src/tui/views/outcomes-panel.tsx`, `src/tui/views/bounties-panel.tsx`, `src/tui/views/gossip-panel.tsx`, `src/tui/views/github-panel.tsx`, `src/tui/views/vfs-browser.tsx`, `src/tui/views/artifact-preview.tsx`, `src/tui/views/terminal.tsx` — covered by PR3/PR4.
- `src/tui/hooks/use-polled-data.ts` (and tests) — stays in tree; non-Entity callers still need it. Deletion: PR5.
- `src/tui/hooks/use-panel-state.ts`, `src/tui/hooks/use-refresh-context.ts` — stay; PR5 deletes.
- The `setInterval` cleanup loops in `main.ts` (claim cleanup, blob GC, session GC) — PR5 moves them.

---

## Tasks

### Task 1: Per-mode `SUPPORTED_KINDS` + `supportsKind` API

**Files:**
- Modify: `src/core/informer.ts`
- Modify: `src/core/informer.test.ts`

- [ ] **Step 1:** In `informer.ts`, replace the single module-level `SUPPORTED_KINDS` with a per-mode set. Remote mode: `["Contribution", "Claim"]` (unchanged). Local mode: `["Contribution", "Claim", "AgentSession"]`.

- [ ] **Step 2:** Add `factory.supportsKind(kind: WatchKind): boolean` reading the per-mode set.

- [ ] **Step 3:** Update `informerFor` to consult the per-mode set when throwing the "kind not yet supported" error. Update the error message to mention the mode.

- [ ] **Step 4:** Update `startAll()` to iterate the per-mode set so a local-mode factory eagerly starts an AgentSession informer.

- [ ] **Step 5:** Add `factory.mode: "remote" | "local"` getter (read from `opts.mode`). Used by hook callers to gate AgentSession migrations in remote mode.

- [ ] **Step 6:** Tests:
  - Remote factory: `supportsKind("AgentSession") === false`; `informerFor("AgentSession")` throws.
  - Local factory: `supportsKind("AgentSession") === true`; `informerFor("AgentSession")` returns an Informer.
  - Both: `supportsKind("Contribution") === true` and `supportsKind("Claim") === true`.

**Acceptance:** `bun test src/core/informer.test.ts` passes. `bunx tsc --noEmit` clean.

### Task 2: `WatchHubRecorder` helper

**Files:**
- Create: `src/local/watch-hub-recorder.ts`
- Create: `src/local/watch-hub-recorder.test.ts`

- [ ] **Step 1:** Define the recorder API:

```ts
export interface WatchHubRecorder {
  contribution(op: InformerOp, c: Contribution): void;
  claim(op: InformerOp, c: Claim, now?: () => number): void;
  agentSession(op: InformerOp, s: AgentSession): void;
}
export function createWatchHubRecorder(opts: {
  hub: WatchHub;
  namespace: string;
  now?: () => number;
}): WatchHubRecorder;
```

Each method projects via the existing `contributionToEntity` / `claimToEntity` / `agentSessionToEntity` helpers and calls `hub.recordWrite({ kind, namespace, op, entity })`.

- [ ] **Step 2:** Tests with a hand-rolled fake hub (capturing `recordWrite` calls). Assert one call per invocation, correct kind, op, namespace, entity id.

- [ ] **Step 3:** Verify the recorder swallows recordWrite throws (defensive; downstream subscriber failures must not poison the write path). Log to stderr on throw.

**Acceptance:** Recorder tests pass. No new lint warnings.

### Task 3: Local store `onEntityWrite` hooks

**Files:**
- Modify: `src/local/sqlite-store.ts`
- Modify: existing store tests as needed

- [ ] **Step 1:** Add `onEntityWrite?: (event: EntityWriteEvent) => void` field to `SqliteContributionStore` and `SqliteClaimStore`. Mirror the existing `onWrite` pattern (public mutable field, default no-op).

- [ ] **Step 2:** Fire the callback from each successful write path:
  - `SqliteContributionStore.contribute` (and any other write — search the file with `INSERT INTO contributions`): emit `{ kind: "Contribution", op: "ADDED", namespace, entity: contributionToEntity(c, ns) }`. The store doesn't know the namespace today; thread it as a constructor arg or via a setter (`store.namespace = ns`).
  - `SqliteClaimStore.claim` / `heartbeat` / `expire` / `complete`: emit Claim events. **Skip pure heartbeat-only updates** that don't change the lease boundary or status — match the rule documented on `OperationDeps.onEntityWrite` (`deps.ts:81`).

- [ ] **Step 3:** Tests: write a contribution → callback receives correct event. Write a claim and complete it → ADDED + MODIFIED. Heartbeat-only update → no callback.

- [ ] **Step 4:** Bound the change so existing callers (server, CLI) stay untouched: default `onEntityWrite = noop`. Server still wires its own `recordWrite` via the operation-adapter, so adding the local-store hook does not double-fire when the server is the consumer (server doesn't construct local stores; it owns the operation dependency injection).

**Acceptance:** `bun test src/local/sqlite-store.test.ts` and `src/core/store.conformance.ts` pass. Conformance suite unchanged (no semantic shift, only an additive hook).

### Task 4: Agent runtime `onSessionWrite` hook

**Files:**
- Modify: `src/core/agent-runtime.ts` (or the concrete impl that owns session lifecycle — `acp-runtime.ts` / acpx wrapper, whichever fires spawn/close)

- [ ] **Step 1:** Survey: identify the single chokepoint where AgentSession lifecycle transitions are observable (`spawn`, `status` flip, `close`). For ACP runtimes that's likely `acp-runtime.ts`'s session map; for tmux fallback there may not be one (acceptable — AgentSession entities won't update from tmux state, but the local-mode AgentSession listFn will still snapshot them).

- [ ] **Step 2:** Add an optional `onSessionWrite?: (event: EntityWriteEvent) => void` (mirror Task 3's pattern). Fire on spawn (ADDED), status transition (MODIFIED), close (DELETED).

- [ ] **Step 3:** Test the spawn → ADDED + close → DELETED sequence with an in-process fake runtime if one exists. If not, defer to the integration test in Task 8.

**Acceptance:** Existing agent-runtime tests pass. New hook fires only when wired.

### Task 5: `LocalRuntime` wiring

**Files:**
- Modify: `src/local/runtime.ts`

- [ ] **Step 1:** Add `watchHub?: WatchHub | undefined` to `LocalRuntimeOptions` and `LocalRuntime`.

- [ ] **Step 2:** When `watchHub` is provided and a `namespace` opt is also provided (mirror server-side namespacing — typically `"default"` for local mode), construct a `WatchHubRecorder` and wire it onto the contribution / claim stores' `onEntityWrite`. Plumb the namespace through to the stores so each callback knows what `namespace` to attach.

- [ ] **Step 3:** No agent-runtime wiring here — the agent runtime is constructed in `tui/main.ts` after `createLocalRuntime`. PR2 wires that in main.ts.

- [ ] **Step 4:** Tests: `createLocalRuntime({ ..., watchHub })` then write a contribution → hub receives one event with correct rv increment.

**Acceptance:** Existing `runtime.test.ts` still passes. New test asserts the hub plumbing.

### Task 6: TUI main wiring (factory in local mode + eager flag)

**Files:**
- Modify: `src/tui/main.ts`

- [ ] **Step 1:** In `buildAppProps`, when `backend.mode === "local"` (or when grove-server is unreachable and we fall back to local):
  - Construct a process-local `WatchHub`.
  - Construct a `cleanupRuntime` (already exists for the GC timers) but extended with `watchHub` and `namespace: "default"` so contribution + claim writes flow through `recordWrite`.
  - Wire `agentRuntime.onSessionWrite = (e) => watchHub.recordWrite(e)` after the runtime is constructed.
  - Build the `InformerFactory` with `mode: "local"`:
    ```ts
    new InformerFactory({
      mode: "local",
      hub: watchHub,
      namespace: "default",
      listFn: (kind) => {
        switch (kind) {
          case "Contribution": return cleanupRuntime.contributionStore.listEntities();
          case "Claim": return cleanupRuntime.claimStore.listEntities();
          case "AgentSession":
            return (await agentRuntime?.listSessions() ?? []).map(s => agentSessionToEntity(s, undefined, "default"));
        }
      }
    });
    ```
    `listFn` matches the discriminated-union shape PR1 already accepts (sync or async). For AgentSession on a tmux-only runtime where `agentRuntime` is undefined, return `[]` — the informer will sync to an empty cache, which is correct (no AgentSession entities are tracked in that mode).

- [ ] **Step 2:** Pass `eager={true}` to `<InformerProviderHolder>` and to the legacy `--url` `<InformerProvider>` wrap in `handleTui`. (PR1 left it implicit `false` for dark-ship.)

- [ ] **Step 3:** Drop the lazy-only construction comment ("intentionally NOT wired in PR1") and replace with a short note pointing at this plan as the rationale.

- [ ] **Step 4:** Verify the existing remote-mode path (with `authHeader`) still constructs the same factory shape it did in PR1 — only the local-mode branch and the `eager` flag change.

**Acceptance:** `bun tui` boots in both `--nexus` (remote) and bare local modes without runtime errors. Both paths log `factory.mode` once at boot for ops visibility.

### Task 7: View migrations

Each view is a self-contained sub-task. Land them in dependency order (Claim views first, then Contribution, then AgentSession portions guarded by `supportsKind`). Per migration: replace the polling fetcher with the informer hook, drop `intervalMs` from the call where it becomes unused (keep the prop for future poll-fallback callers if PR4 needs it), preserve the existing display shape by mapping `Entity → row` at the call site.

#### 7a — `claims.tsx`

**Files:**
- Modify: `src/tui/views/claims.tsx`
- Create: `src/tui/views/claims.test.tsx`

- [ ] **Step 1:** Replace `usePolledData(provider.getClaims({status:"active"}))` with `useEntities("Claim", e => e.status.phase === "active")`. The `propClaims` override stays — parent still passes a pre-fetched list to avoid double-polling for now. When `propClaims === undefined`, use the hook's `data`.

- [ ] **Step 2:** Map `ClaimEntity → row` at the row layer. The current code reads `c.status` (string), `c.leaseExpiresAt`, `c.heartbeatAt`, `c.targetRef`, `c.intentSummary`, `c.agent.agentName ?? c.agent.agentId`. From `ClaimEntity`: `entity.status.phase`, `entity.status.leaseExpiresAt`, `entity.status.heartbeatAt`, `entity.spec.targetRef`, `entity.spec.intentSummary`, `entity.spec.agent.agentName ?? entity.spec.agent.agentId`. Keep the existing duplicate-target detection and "expired" status logic.

- [ ] **Step 3:** Smoke test in `claims.test.tsx`: mount with a fake informer factory pre-seeded with two claims, assert two rows. Publish a third claim event, assert three rows. Match the pattern in `use-entities.test.ts`.

**Acceptance:** Test passes. Visual check (manual): `grove tui` claims panel still renders.

#### 7b — `agent-list.tsx`

**Files:**
- Modify: `src/tui/views/agent-list.tsx`
- Create: `src/tui/views/agent-list.test.tsx`

- [ ] **Step 1:** Claim portion: same swap as 7a, using `useEntities("Claim", c => c.status.phase === "active")`.

- [ ] **Step 2:** Session portion: branch on `factory.supportsKind("AgentSession")`. When supported, use `useEntities("AgentSession", …)` and derive the session-name list from entity ids. When not supported, keep `usePolledData(tmux.listSessions, intervalMs * 2, …)`.

- [ ] **Step 3:** The cost fetcher (`getSessionCosts`) stays on `usePolledData` — non-Entity, PR4.

- [ ] **Step 4:** Smoke test: claim + session pre-seeded, assert agent rows. Publish session event, assert row update (when local mode supported).

#### 7c — `pipeline-view.tsx`

**Files:**
- Modify: `src/tui/views/pipeline-view.tsx`
- Create: `src/tui/views/pipeline-view.entity.test.ts`

- [ ] **Step 1:** Claim portion → `useEntities("Claim", c => c.status.phase === "active")`.

- [ ] **Step 2:** Session-list portion → mode-branch as in 7b.

- [ ] **Step 3:** Output capture (`tmux.capturePanes`) stays on `usePolledData` — non-Entity, PR4.

- [ ] **Step 4:** Smoke test: seed two Claims with parent/child lineage, assert ordered cards. Existing `pipeline-view.test.ts` already covers `buildPipeline` purely; new test mounts the React component.

#### 7d — `agent-graph.tsx`

**Files:**
- Modify: `src/tui/views/agent-graph.tsx`
- Create: `src/tui/views/agent-graph.test.tsx`

- [ ] **Step 1:** Claim → `useEntities("Claim", …)`. Session → mode-branch.

- [ ] **Step 2:** `buildDynamicEdges` keeps reading the claim list from the hook's `data`.

- [ ] **Step 3:** Smoke test: seed two Claims with a parent edge, assert renderGraph output contains both roles.

#### 7e — `activity.tsx`

**Files:**
- Modify: `src/tui/views/activity.tsx`
- Create: `src/tui/views/activity.test.tsx`

- [ ] **Step 1:** Replace `usePolledData(getActivity({limit:pageSize, offset:pageOffset}))` with:
  ```ts
  const { data } = useEntities("Contribution");
  const sorted = useMemo(
    () => [...data].sort((a, b) => (b.metadata.creationTimestamp ?? "").localeCompare(a.metadata.creationTimestamp ?? "")),
    [data],
  );
  const sliced = sorted.slice(pageOffset, pageOffset + pageSize);
  ```
  Map `ContributionEntity → row` (`entity.id` → `c.cid`, `entity.spec.contributionKind` → `c.kind`, etc.).

- [ ] **Step 2:** Caveat: the informer cache is bounded by what PR1's listFn returns. For "load more" beyond the cached window, the user falls back to a hard refresh (`r` key triggers `factory.relist`). Document this in a 1-line comment in `activity.tsx`.

- [ ] **Step 3:** Smoke test: seed N=10 contributions, paginate at pageSize=3, assert correct slice. Publish an 11th, assert it appears at offset=0.

#### 7f — `activity-panel.tsx`

**Files:**
- Modify: `src/tui/views/activity-panel.tsx`
- Create: `src/tui/views/activity-panel.test.tsx`

- [ ] **Step 1:** Same `useEntities("Contribution")` + `.slice(0, 30)` pattern as `activity.tsx` (no pagination).

- [ ] **Step 2:** Smoke test: 30 contributions, assert all 30 rows. 31st contribution event → still 30 rows (newest first).

#### 7g — `search-panel.tsx`

**Files:**
- Modify: `src/tui/views/search-panel.tsx`
- Create: `src/tui/views/search-panel.entity.test.ts`

- [ ] **Step 1:** When `searchQuery === ""` (the "showing recent contributions" branch in `selectFetcher`): replace with `useEntities("Contribution")` + `.slice(0, 20)`. Keep `selectFetcher` exported for unit-test compatibility but route the `getContributions` branch through the informer cache.

- [ ] **Step 2:** When `searchQuery !== ""`: stay on `usePolledData` + `provider.search` (full-text — non-Entity until PR4).

- [ ] **Step 3:** Smoke test: empty query → cache contents. Set query → poll path triggers (existing test coverage in `search-panel.test.ts` exercises `selectFetcher`; new test asserts cache delivery for empty query).

#### 7h — `detail.tsx`

**Files:**
- Modify: `src/tui/views/detail.tsx`
- Create: `src/tui/views/detail.test.tsx`

- [ ] **Step 1:** The contribution body lookup → `useEntity("Contribution", cid)`. The view already builds a `ContributionEntity` via `contributionToEntity(c, "default")` for the conditions chip — the hook returns one directly. Drop the redundant projection.

- [ ] **Step 2:** Ancestors / children / thread / outcome stay on `usePolledData(provider.getContribution(cid))` — those fields aren't on the Entity envelope (it's a `ContributionDetail` shape that includes the relation graph). PR3 follow-up may lift the relation graph into `useDerived` over the Contribution informer, but PR2 keeps the existing fetch.

- [ ] **Step 3:** Smoke test: seed contribution into the informer, mount with `cid`, assert body fields render.

#### 7i — `panels/panel-manager.tsx`

**Files:**
- Modify: `src/tui/panels/panel-manager.tsx`
- Create: `src/tui/panels/panel-manager.entity.test.ts`

- [ ] **Step 1:** The inline `usePolledData(getContribution(detailCid))` (used to resolve `artifactNames` from the contribution) → `useEntity("Contribution", detailCid)`. Read `entity.spec.artifacts` instead of `detailData.contribution.artifacts`. Read the `derives_from` relation from `entity.spec.relations` instead of `detailData.contribution.relations`.

- [ ] **Step 2:** Smoke test: seed a contribution with two artifacts and a `derives_from` relation, assert `artifactNames` resolves correctly and `parentCid` is the relation target.

### Task 8: End-to-end smoke (real factory, real WatchHub)

**Files:**
- Create: `tests/e2e/tui-pr2-informer-smoke.test.ts` (or add to an existing TUI smoke harness if one exists)

- [ ] **Step 1:** Boot a local-mode `LocalRuntime` with a fresh in-memory SQLite, attach a `WatchHub`. Construct a local-mode `InformerFactory`. Start it. Assert `hasSynced` flips for `Contribution` and `Claim` (and `AgentSession` if a fake agent runtime is plugged in).

- [ ] **Step 2:** Through the `OperationDeps` layer (or directly via the store), write a Claim. Assert the hub receives one event and the informer cache contains one entry.

- [ ] **Step 3:** Run `factory.relist("Claim")`. Assert RELIST_BEGIN → RELIST → RELIST_END sequence and the cache content is unchanged.

- [ ] **Step 4:** Stop the factory. Assert all three informers exit cleanly within 1s.

**Acceptance:** Test stable across 5 sequential runs. No leaked timers / open handles.

### Task 9: Verification

- [ ] **Step 1:** `bunx tsc --noEmit` clean.
- [ ] **Step 2:** `bun test` clean (full suite, not just touched files — confirm no regressions in store conformance, informer lifecycle, watch-stream contract).
- [ ] **Step 3:** `bun biome check .` clean for migrated files.
- [ ] **Step 4:** Manual smoke: `grove tui` in a real `.grove` worktree. Open Claims panel — claim list shows. Open Activity panel — recent contributions show. Spawn a claim via the operations layer (`bun run grove claim create …` from another shell) — claim appears in the TUI without re-entering the panel.
- [ ] **Step 5:** Manual smoke: with `--nexus`, both Claim and Contribution panels still render and update on server-side writes (existing remote-mode regression check). AgentSession panel (in views that branch on `supportsKind`) falls back to the tmux poller without errors.
- [ ] **Step 6:** Update the AgentSession scope decision section if implementation found that AgentSession migration was unnecessary or required a different approach.

**Acceptance:** All steps green. `grep -r "usePolledData" src/tui/views src/tui/panels` shows the post-PR2 state — only non-Entity callers (vfs, terminal, gossip, threads, bounties, outcomes, decisions, GitHub, search-with-query, dag, dashboard, frontier, handoffs, artifact-preview) remain on the hook.

---

## Risks and mitigations

- **Local-store `onEntityWrite` double-fires when server is local-mode wrapped.** → Server doesn't go through `createLocalRuntime` for store wiring; it constructs its own deps and wires `recordWrite` via `operation-adapter.ts:36`. Adding the store-level hook only affects callers that don't have an operation-adapter (today: TUI local-mode + tests). Confirm by grep: `createLocalRuntime` callers should never also pass `onEntityWrite` through `OperationDeps` — if both fire, write-amplification doubles RV counters and breaks watch contracts. Cover with a server integration test if one exists; otherwise document as a known constraint of the API.

- **AgentSession listFn races spawn.** → If `factory.relist("AgentSession")` runs before `agentRuntime.spawn` returns, the snapshot misses the new session and the user sees stale state until the next `recordWrite`. Mitigation: spawn fires `recordWrite(ADDED)` synchronously before resolving the promise. Cover with the smoke test in Task 8.

- **`useEntities("Contribution")` returns the entire cache every render.** → For 100k-row groves the `.slice` is O(n) per render. Acceptable for now (informer cache is bounded by listFn snapshot + typical grove size in PR2 timeframe); revisit in PR3 if profiling shows it matters. Spec already calls this out under risks (line 300).

- **Eager start in interactive flow surfaces error noise before the user picks a backend.** → PR1 ran with `eager=false` for exactly this reason. PR2 flips to `eager=true` only AFTER the InformerProviderHolder receives a factory (the holder pattern in PR1 already handles this — `holder.set()` is called from `onInit/onStart/onConnect` after `buildAppProps` resolves, which is after the backend is chosen). The pre-set window renders without context and no informer is started.

- **Smoke tests depend on a React renderer.** → PR1 already established the `bun:test` pattern with React + jsdom-style harness for `use-entities.test.ts`. Reuse the same setup.

- **AgentSession migration in remote mode falls back silently.** → The mode branch (`factory.supportsKind`) is explicit and visible in the diff. Add a one-line comment per call site documenting the fallback. PR4/follow-up adds the server-side route.

## Open items deferred to PR3+

- AgentSession server-side `/api/list` + `/api/watch` routes (#287 follow-up; not on the A8 critical path).
- Full-text search → informer cache hybrid (currently only the empty-query branch migrates).
- ContributionDetail (ancestors / children / thread) projection through `useDerived` — PR3.
- Removing `intervalMs` props that became dead weight after migration — coordinate with PR5 cleanup pass.
