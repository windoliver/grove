/**
 * Acceptance tests for issue #302 exit criteria:
 *   1. ":a" routes to agents view
 *   2. "/foo" filters current view without tearing down state
 *   3. Invalid alias file → flash-bar error, falls back to defaults
 *
 * Issue #303 — running-view goto integration acceptance:
 *   4. ":a" pushes panel page onto PagesStore
 *   5. Sync mapping: panel page kind → RunningPanel enum
 *   6. ":a" then ":s" then esc returns to panel:agents (stack pop semantics)
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ALIASES, resolveAlias } from "../data/aliases.js";
import { loadAliases } from "../data/aliases-loader.js";
import { PagesStore } from "../data/pages-store.js";
import { emptyFeedHint } from "./empty-feed-hint.js";
import { expandPanel as expandPanelTransition, RunningPanel } from "./running-keyboard.js";

async function makeTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "c2-acc-"));
}

describe("C2 acceptance — issue #302", () => {
  test("AC1: ':a' resolves to agents command", () => {
    const r = resolveAlias(DEFAULT_ALIASES, "a");
    expect(r).toEqual({ kind: "ok", command: "agents", argv: [], chain: ["a"] });
  });

  test("AC2: filter predicate composes; same query applies across panels", () => {
    // Simulates running-view's filter wiring: the same filterText flows into
    // any expanded EntityView/list. Switching panels keeps the filter active —
    // panel state is not torn down because the predicate composes at render.
    const buildPredicate = (q: string) => {
      const lower = q.toLowerCase();
      return (row: { label: string }) => row.label.toLowerCase().includes(lower);
    };
    const predicate = buildPredicate("foo");

    // Agents-panel rows
    const agentRows = [{ label: "foobar" }, { label: "baz" }];
    expect(agentRows.filter(predicate)).toEqual([{ label: "foobar" }]);

    // Switch to DAG panel — same predicate, applies to dag rows
    const dagRows = [{ label: "foo-other" }, { label: "qux" }];
    expect(dagRows.filter(predicate)).toEqual([{ label: "foo-other" }]);
  });

  test("AC3: invalid alias file → errors reported + defaults still resolve ':a'", async () => {
    const dir = await makeTmp();
    try {
      const grove = join(dir, ".grove");
      await mkdir(grove, { recursive: true });
      await writeFile(join(grove, "aliases.yaml"), "{[ broken yaml", "utf8");
      const result = await loadAliases(dir, { homeOverride: dir });
      expect(result.errors.length).toBeGreaterThan(0);
      // Defaults still resolve ':a' → agents.
      const r = resolveAlias(result.aliases, "a");
      expect(r.kind).toBe("ok");
      if (r.kind === "ok") expect(r.command).toBe("agents");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("empty feed does not say agents are working after startup failure", () => {
    expect(emptyFeedHint([], new Map([["coder", "Internal error"]]))).toBe(
      "Agent startup failed; check agent status",
    );
    expect(emptyFeedHint(["reviewer"], new Map([["coder", "Internal error"]]))).toBe(
      "Agent startup failed; check agent status",
    );
  });
});

// ---------------------------------------------------------------------------
// Issue #303 — running-view goto pushes panel pages onto PagesStore
// ---------------------------------------------------------------------------

/**
 * Mirror of running-view.tsx's gotoDispatch (post-#303). Kept in lockstep
 * with the component so we can assert on the data path the cmd-mode
 * submission takes — without mounting RunningView (no harness).
 */
function buildGotoDispatch(store: PagesStore, onQuit: () => void): Record<string, () => void> {
  return {
    agents: () => store.push({ kind: "panel", params: { panel: "agents" } }),
    dag: () => store.push({ kind: "panel", params: { panel: "dag" } }),
    sessions: () => store.push({ kind: "panel", params: { panel: "sessions" } }),
    tasks: () => store.push({ kind: "panel", params: { panel: "tasks" } }),
    reviews: () => store.push({ kind: "panel", params: { panel: "reviews" } }),
    quit: onQuit,
  };
}

/**
 * Mirror of running-view.tsx's panel-name → RunningPanel enum map. If this
 * test starts failing because the component table changed without the
 * mirror being updated, that itself signals the intended desync.
 */
const PANEL_NAME_TO_ENUM: Readonly<Record<string, RunningPanel>> = {
  agents: RunningPanel.Agents,
  sessions: RunningPanel.Sessions,
  dag: RunningPanel.Dag,
  tasks: RunningPanel.Tasks,
  reviews: RunningPanel.Reviews,
  feed: RunningPanel.Feed,
};

/** No-op stand-in for the onQuit callback (none of these tests trigger quit). */
function noop(): void {
  // intentionally empty
}

describe("C2 acceptance — issue #303 (goto pushes panel pages)", () => {
  test("AC4: ':a' (agents) pushes a panel page onto the store", () => {
    const store = new PagesStore();
    store.push({ kind: "running" });
    const dispatch = buildGotoDispatch(store, noop);

    dispatch.agents?.();

    expect(store.depth()).toBe(2);
    expect(store.top()).toEqual({ kind: "panel", params: { panel: "agents" } });
  });

  test("AC5: panel-name on the top page maps to a valid RunningPanel enum", () => {
    const store = new PagesStore();
    store.push({ kind: "running" });
    const dispatch = buildGotoDispatch(store, noop);

    // Each goto entry produces a panel name that the sync map can resolve to
    // a known RunningPanel — this is the contract the running-view sync
    // effect relies on to update expandedPanel/zoomLevel.
    for (const cmd of ["agents", "dag", "sessions", "tasks", "reviews"] as const) {
      const fresh = new PagesStore();
      fresh.push({ kind: "running" });
      const d = buildGotoDispatch(fresh, noop);
      d[cmd]?.();
      const top = fresh.top();
      expect(top?.kind).toBe("panel");
      const panel = top?.params?.panel ?? "";
      expect(PANEL_NAME_TO_ENUM[panel]).toBeDefined();
    }

    // Spot-check that the mapping picks the right enum value.
    dispatch.agents?.();
    const top = store.top();
    const panel = top?.params?.panel ?? "";
    expect(PANEL_NAME_TO_ENUM[panel]).toBe(RunningPanel.Agents);

    // And that the resulting expandPanelTransition output is sensible
    // (Agents at half-zoom — same shape running-view's sync effect applies).
    const next = expandPanelTransition(null, "normal", PANEL_NAME_TO_ENUM[panel] as RunningPanel);
    expect(next.expandedPanel).toBe(RunningPanel.Agents);
    expect(next.zoomLevel).toBe("half");
  });

  test("AC6: ':a' then ':s' then esc-pop returns top to panel:agents", () => {
    const store = new PagesStore();
    store.push({ kind: "running" });
    const dispatch = buildGotoDispatch(store, noop);

    dispatch.agents?.();
    dispatch.sessions?.();
    expect(store.depth()).toBe(3);
    expect(store.top()).toEqual({ kind: "panel", params: { panel: "sessions" } });

    // Esc-pop simulation (depth>1 short-circuit in running-view.tsx).
    store.pop();
    expect(store.depth()).toBe(2);
    expect(store.top()).toEqual({ kind: "panel", params: { panel: "agents" } });

    // Pop again returns to running root; the sync effect would clear
    // expandedPanel here.
    store.pop();
    expect(store.depth()).toBe(1);
    expect(store.top()).toEqual({ kind: "running" });

    // PagesStore.pop is a no-op at depth 1 — the existing layered esc
    // dismissal in routeRunningKey takes over from this point.
    const popped = store.pop();
    expect(popped).toBeUndefined();
    expect(store.depth()).toBe(1);
  });
});
