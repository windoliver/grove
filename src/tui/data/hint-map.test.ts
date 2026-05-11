/**
 * Tests for the central hint-map module (issue #309).
 */

import { describe, expect, it } from "bun:test";
import { DEFAULT_HINTS, hintsForPage, type KeyAction } from "./hint-map.js";
import type { PageKind } from "./pages-store.js";

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

  const NON_PANEL_KINDS = ALL_PAGE_KINDS.filter((k) => k !== "panel" && k !== "entity-detail");

  for (const kind of NON_PANEL_KINDS) {
    it(`hintsForPage({kind:"${kind}"}) → frozen, non-empty`, () => {
      const hints = hintsForPage({ kind });
      expect(hints.length).toBeGreaterThan(0);
      expect(Object.isFrozen(hints)).toBe(true);
    });
  }
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
