/**
 * Tests for the central hint-map module (issue #309).
 */

import { describe, expect, it } from "bun:test";
import { DEFAULT_HINTS, hintsForPage, type KeyAction } from "./hint-map.js";
import type { Page, PageKind } from "./pages-store.js";

// ---------------------------------------------------------------------------
// 1. hintsForPage({kind:"running"}) returns non-empty KeyAction[] with
//    string key + string label on the first element.
// ---------------------------------------------------------------------------
describe("hintsForPage - running page", () => {
  it("returns a non-empty array with string key and label", () => {
    const hints = hintsForPage({ kind: "running" });
    expect(hints.length).toBeGreaterThan(0);
    const first = hints[0];
    expect(first).toBeDefined();
    expect(typeof first!.key).toBe("string");
    expect(typeof first!.label).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 2. Every non-panel PageKind resolves to a frozen, non-empty array.
// ---------------------------------------------------------------------------
describe("hintsForPage - all non-panel/non-detail page kinds", () => {
  const ALL_PAGE_KINDS: readonly PageKind[] = [
    "preset-select",
    "goal-input",
    "agent-detect",
    "launch-preview",
    "spawning",
    "running",
    "complete",
    "advanced",
    "panel",
    "entity-detail",
  ];

  // Spawning is deliberately empty — see hint-map.ts STATIC entry comment.
  // It has no keyboard handlers, so showing any hint would be misleading.
  const KINDS_WITH_HINTS = ALL_PAGE_KINDS.filter(
    (k) => k !== "panel" && k !== "entity-detail" && k !== "spawning",
  );

  for (const kind of KINDS_WITH_HINTS) {
    it(`hintsForPage({kind:"${kind}"}) → frozen, non-empty`, () => {
      const hints = hintsForPage({ kind });
      expect(hints.length).toBeGreaterThan(0);
      expect(Object.isFrozen(hints)).toBe(true);
    });
  }

  it('hintsForPage({kind:"spawning"}) → frozen, empty (no wired keys)', () => {
    const hints = hintsForPage({ kind: "spawning" });
    expect(hints).toEqual([]);
    expect(Object.isFrozen(hints)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. DEFAULT_HINTS is frozen and non-empty.
// ---------------------------------------------------------------------------
describe("DEFAULT_HINTS", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(DEFAULT_HINTS)).toBe(true);
  });

  it("is non-empty", () => {
    expect(DEFAULT_HINTS.length).toBeGreaterThan(0);
  });

  it("each KeyAction entry is frozen (deep-freeze contract)", () => {
    for (const action of DEFAULT_HINTS) {
      expect(Object.isFrozen(action)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3b. Deep-freeze contract: every hint set returned by hintsForPage
//     must freeze its KeyAction entries, not just the outer array. Without
//     this, callers could mutate `entry.key` / `entry.label` and corrupt
//     all future renders sharing that module-singleton array.
// ---------------------------------------------------------------------------
describe("KeyAction deep-freeze contract", () => {
  const PAGES_TO_CHECK: readonly Page[] = [
    { kind: "running" },
    { kind: "goal-input" },
    { kind: "complete" },
    { kind: "advanced" },
    { kind: "preset-select" },
    { kind: "agent-detect" },
    { kind: "launch-preview" },
    { kind: "panel", params: { panel: "agents" } },
    { kind: "panel", params: { panel: "dag" } },
  ];

  for (const page of PAGES_TO_CHECK) {
    const tag = page.kind === "panel" ? `panel:${page.params?.panel}` : page.kind;
    it(`hintsForPage(${tag}) returns entries that are individually frozen`, () => {
      const hints = hintsForPage(page);
      expect(hints.length).toBeGreaterThan(0);
      for (const action of hints) {
        expect(Object.isFrozen(action)).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 4. panel:dag deep-equals the acceptance spec from issue #309.
// ---------------------------------------------------------------------------
describe("hintsForPage - panel:dag", () => {
  it("matches acceptance spec exactly", () => {
    const hints = hintsForPage({ kind: "panel", params: { panel: "dag" } });
    expect(hints).toEqual([
      { key: "Enter", label: "Focus" },
      { key: "Space", label: "Expand" },
      { key: "R", label: "Review" },
      { key: "M", label: "Merge" },
      { key: "L", label: "Logs" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5. All 6 panel names resolve to non-empty arrays.
// ---------------------------------------------------------------------------
describe("hintsForPage - all panel sub-kinds", () => {
  const PANEL_NAMES = ["agents", "dag", "sessions", "tasks", "reviews", "feed"];

  for (const panel of PANEL_NAMES) {
    it(`panel:${panel} → non-empty`, () => {
      const hints = hintsForPage({ kind: "panel", params: { panel } });
      expect(hints.length).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// 6. Unknown panel → identity === DEFAULT_HINTS.
// ---------------------------------------------------------------------------
describe("hintsForPage - unknown panel", () => {
  it("returns DEFAULT_HINTS by identity for unknown panel", () => {
    const hints = hintsForPage({ kind: "panel", params: { panel: "unknown-xyz" } });
    expect(hints).toBe(DEFAULT_HINTS);
  });
});

// ---------------------------------------------------------------------------
// 7. panel kind with no params → identity === DEFAULT_HINTS.
// ---------------------------------------------------------------------------
describe("hintsForPage - panel with no params", () => {
  it("returns DEFAULT_HINTS by identity when params is absent", () => {
    const hints = hintsForPage({ kind: "panel" });
    expect(hints).toBe(DEFAULT_HINTS);
  });

  it("returns DEFAULT_HINTS by identity when panel param is absent", () => {
    const hints = hintsForPage({ kind: "panel", params: {} });
    expect(hints).toBe(DEFAULT_HINTS);
  });
});

// ---------------------------------------------------------------------------
// 8. entity-detail with no params / unknown kind → identity === DEFAULT_HINTS.
// ---------------------------------------------------------------------------
describe("hintsForPage - entity-detail fallback", () => {
  it("returns DEFAULT_HINTS when no params", () => {
    const hints = hintsForPage({ kind: "entity-detail" });
    expect(hints).toBe(DEFAULT_HINTS);
  });

  it("returns DEFAULT_HINTS for unknown entity kind", () => {
    const hints = hintsForPage({ kind: "entity-detail", params: { kind: "unknown-entity" } });
    expect(hints).toBe(DEFAULT_HINTS);
  });
});

// ---------------------------------------------------------------------------
// 9. KeyAction has exactly {key, label} keys — no extras leaked.
// ---------------------------------------------------------------------------

function hintKeys(hint: KeyAction): string[] {
  return Object.keys(hint as unknown as Record<string, unknown>);
}

describe("KeyAction shape", () => {
  it("every hint in DEFAULT_HINTS has exactly {key, label}", () => {
    for (const hint of DEFAULT_HINTS) {
      expect(hintKeys(hint).sort()).toEqual(["key", "label"]);
    }
  });

  it("every hint in running page has exactly {key, label}", () => {
    const hints = hintsForPage({ kind: "running" });
    for (const hint of hints) {
      expect(hintKeys(hint).sort()).toEqual(["key", "label"]);
    }
  });

  it("every hint in panel:dag has exactly {key, label}", () => {
    const hints = hintsForPage({ kind: "panel", params: { panel: "dag" } });
    for (const hint of hints) {
      expect(hintKeys(hint).sort()).toEqual(["key", "label"]);
    }
  });
});
