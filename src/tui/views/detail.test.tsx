/**
 * Tests for <DetailView> scrollable, focus-aware rendering (#192).
 *
 * Asserts (a) the section column is wrapped in a <scrollbox>; (b) a long
 * description renders in full (no .slice(0, 500) truncation); (c)
 * `focusedSectionRaw` selects a PRESENT section (skipping absent ones),
 * and the focused section carries the accent border/marker.
 */

import { describe, expect, test } from "bun:test";
import type React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { Contribution } from "../../core/models.js";
import type { ThreadNode } from "../../core/store.js";
import type { ContributionDetail, ProviderCapabilities, TuiDataProvider } from "../provider.js";
import { theme } from "../theme.js";
import { DetailView } from "./detail.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

interface TestNode {
  readonly type?: string;
  readonly props?: Record<string, unknown>;
  readonly children?: readonly unknown[];
}

/** Concatenate every string leaf in the rendered tree. */
function textOf(json: unknown): string {
  if (json == null) return "";
  if (typeof json === "string") return json;
  if (Array.isArray(json)) return json.map(textOf).join("");
  const n = json as { children?: unknown };
  return textOf(n.children);
}

/** True if any node in the tree has the given intrinsic type. */
function hasType(json: unknown, type: string): boolean {
  if (!json || typeof json !== "object") return false;
  const n = json as TestNode;
  if (n.type === type) return true;
  return (n.children ?? []).some((c) => hasType(c, type));
}

/** Collect every node carrying a border (focus accent) keyed by its text. */
function findBorderedTextBlocks(json: unknown, out: string[]): void {
  if (!json || typeof json !== "object") return;
  const n = json as TestNode;
  if (n.props && (n.props.borderStyle !== undefined || n.props.border !== undefined)) {
    out.push(textOf(n));
  }
  for (const c of n.children ?? []) findBorderedTextBlocks(c, out);
}

// ---------------------------------------------------------------------------
// Provider stub
// ---------------------------------------------------------------------------

interface ContribOverrides {
  readonly description?: string;
  readonly scores?: Contribution["scores"];
  readonly summary?: string;
  readonly relations?: Contribution["relations"];
}

function makeContribution(overrides: ContribOverrides = {}): Contribution {
  return {
    cid: "c1",
    manifestVersion: 1,
    kind: "work",
    mode: "evaluation",
    summary: overrides.summary ?? "A summary line",
    description: overrides.description,
    artifacts: {},
    relations: overrides.relations ?? [],
    scores: overrides.scores,
    tags: ["alpha"],
    context: undefined,
    agent: { agentId: "agent-1", agentName: "Tester" },
    createdAt: "2026-05-28T00:00:00.000Z",
  } as Contribution;
}

function longContribution(overrides: ContribOverrides = {}): ContributionDetail {
  return {
    contribution: makeContribution(overrides),
    ancestors: [],
    children: [],
    thread: [] as readonly ThreadNode[],
  };
}

function makeDetailProvider(detail: ContributionDetail): TuiDataProvider {
  const capabilities = {
    outcomes: false,
    artifacts: false,
  } as unknown as ProviderCapabilities;
  return {
    capabilities,
    getContribution: async (): Promise<ContributionDetail | undefined> => detail,
  } as unknown as TuiDataProvider;
}

async function renderDetail(
  detail: ContributionDetail,
  focusedSectionRaw: number,
): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      (
        <DetailView
          provider={makeDetailProvider(detail)}
          cid="c1"
          intervalMs={0}
          focusedSectionRaw={focusedSectionRaw}
        />
      ) as React.ReactElement,
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("detail view (#192)", () => {
  test("wraps content in a scrollbox", async () => {
    const renderer = await renderDetail(longContribution(), 0);
    expect(hasType(renderer.toJSON(), "scrollbox")).toBe(true);
    renderer.unmount();
  });

  test("renders full description (no .slice truncation)", async () => {
    const longDesc = "X".repeat(800); // > old 500 cap
    const renderer = await renderDetail(longContribution({ description: longDesc }), 0);
    expect(textOf(renderer.toJSON()).includes("X".repeat(800))).toBe(true);
    renderer.unmount();
  });

  test("focusedSectionRaw selects a present section (skips absent ones)", async () => {
    // Contribution has summary (present) + scores (present), but NO relations,
    // artifacts, ancestors, children, discussion, context. So present sections
    // are ["summary", "scores"]. focusedSectionRaw=1 must land on "scores",
    // and that block must carry the accent border.
    const detail = longContribution({
      scores: { accuracy: { value: 0.9, direction: "maximize" } },
    });
    const renderer = await renderDetail(detail, 1);
    const bordered: string[] = [];
    findBorderedTextBlocks(renderer.toJSON(), bordered);
    const focusedBlock = bordered.join("\n");
    expect(focusedBlock).toContain("Scores");
    expect(focusedBlock).not.toContain("Summary");
    renderer.unmount();
  });

  test("focusedSectionRaw=1 skips an ABSENT middle section (gap: summary + relations, no scores)", async () => {
    // present = ["summary", "relations"] — "scores" is ABSENT but sits
    // between them in SECTION_ORDER (index 1). focusedSectionRaw=1 must land
    // on the 2nd PRESENT section ("relations"), NOT on SECTION_ORDER[1]
    // ("scores", which has no data). A naive SECTION_ORDER[raw] regression
    // would focus the absent "scores" and accent nothing / the wrong block.
    const detail = longContribution({
      relations: [{ targetCid: "target-cid-xyz", relationType: "derives_from" }],
    });
    const renderer = await renderDetail(detail, 1);
    const bordered: string[] = [];
    findBorderedTextBlocks(renderer.toJSON(), bordered);
    const focusedBlock = bordered.join("\n");
    // The 2nd present section is "relations" — it must carry the accent.
    expect(focusedBlock).toContain("Relations");
    expect(focusedBlock).toContain("> "); // accent ">" marker on the focused title
    // Neither the 1st present section nor the absent "scores" may be focused.
    expect(focusedBlock).not.toContain("Summary");
    expect(focusedBlock).not.toContain("Scores");
    renderer.unmount();
  });

  test("focusedSectionRaw=-1 wraps to the LAST present section", async () => {
    // present = ["summary", "relations"] (length 2). raw=-1 -> (((-1 % 2)+2)%2)
    // = 1 -> "relations" (the LAST present section).
    const detail = longContribution({
      relations: [{ targetCid: "target-cid-xyz", relationType: "derives_from" }],
    });
    const renderer = await renderDetail(detail, -1);
    const bordered: string[] = [];
    findBorderedTextBlocks(renderer.toJSON(), bordered);
    const focusedBlock = bordered.join("\n");
    expect(focusedBlock).toContain("Relations");
    expect(focusedBlock).not.toContain("Summary");
    renderer.unmount();
  });

  test("focusedSectionRaw=N wraps to the FIRST present section", async () => {
    // present = ["summary", "relations"] (length N=2). raw=N=2 ->
    // (((2 % 2)+2)%2) = 0 -> "summary" (the FIRST present section).
    const detail = longContribution({
      relations: [{ targetCid: "target-cid-xyz", relationType: "derives_from" }],
    });
    const renderer = await renderDetail(detail, 2);
    const bordered: string[] = [];
    findBorderedTextBlocks(renderer.toJSON(), bordered);
    const focusedBlock = bordered.join("\n");
    expect(focusedBlock).toContain("Summary");
    expect(focusedBlock).not.toContain("Relations");
    renderer.unmount();
  });

  test("focusedSectionRaw=0 focuses the first present section (summary)", async () => {
    const renderer = await renderDetail(longContribution(), 0);
    const bordered: string[] = [];
    findBorderedTextBlocks(renderer.toJSON(), bordered);
    expect(bordered.join("\n")).toContain("Summary");
    void theme; // theme.focus used by the view for the border color
    renderer.unmount();
  });

  test("changing focusedSectionRaw re-renders without error (pulse)", async () => {
    // The focus-change accent pulse (useTimeline) must be test-safe: a plain
    // react-test-renderer mount + update is a no-op (all timeline calls live
    // inside useEffect), so updating the focused section must not throw.
    const detail = longContribution({
      scores: { accuracy: { value: 0.9, direction: "maximize" } },
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <DetailView
            provider={makeDetailProvider(detail)}
            cid="c1"
            intervalMs={0}
            focusedSectionRaw={0}
          />
        ) as React.ReactElement,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.update(
        (
          <DetailView
            provider={makeDetailProvider(detail)}
            cid="c1"
            intervalMs={0}
            focusedSectionRaw={1}
          />
        ) as React.ReactElement,
      );
    });
    expect(renderer.toJSON()).toBeDefined();
    renderer.unmount();
  });
});
