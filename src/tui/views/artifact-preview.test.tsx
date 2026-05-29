/**
 * Tests for <ArtifactPreviewView> diff rendering (#192).
 *
 * Asserts the diff is rendered via the OpenTUI <diff> intrinsic (not a
 * hand-rolled <text> blob), and that diffMode maps to the intrinsic's
 * `view` prop ("split" -> "split", "inline" -> "unified").
 */

import { describe, expect, test } from "bun:test";
import type React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type {
  ArtifactMeta,
  ProviderCapabilities,
  TuiArtifactProvider,
  TuiDataProvider,
} from "../provider.js";
import { ArtifactPreviewView, computeUnifiedDiff } from "./artifact-preview.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface TestNode {
  readonly type?: string;
  readonly props?: Record<string, unknown>;
  readonly children?: readonly unknown[];
}

/** Recurse the rendered tree and return the first node with the given type. */
function findNode(json: unknown, type: string): TestNode | undefined {
  if (!json || typeof json !== "object") return undefined;
  const node = json as TestNode;
  if (node.type === type) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, type);
    if (found) return found;
  }
  return undefined;
}

/** Minimal artifact provider stub exposing artifacts capability + diffArtifacts. */
function makeArtifactProvider(): TuiDataProvider {
  const capabilities = { artifacts: true } as unknown as ProviderCapabilities;
  const artifactImpl: Partial<TuiArtifactProvider> = {
    getArtifactMeta: async (): Promise<ArtifactMeta> => ({
      sizeBytes: 12,
      mediaType: "text/plain",
    }),
    getArtifact: async (): Promise<Buffer> => Buffer.from("child line\n"),
    diffArtifacts: async () => ({ parent: "parent line\nshared\n", child: "child line\nshared\n" }),
  };
  return { capabilities, ...artifactImpl } as unknown as TuiDataProvider;
}

async function renderDiff(diffMode: "inline" | "split"): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      (
        <ArtifactPreviewView
          provider={makeArtifactProvider()}
          cid="childcid01"
          artifactName="a.txt"
          parentCid="parentcid9"
          showDiff
          diffMode={diffMode}
          active
        />
      ) as React.ReactElement,
    );
  });
  // Let the async fetcher resolve and flush effects. The diff data loads via
  // useEventDrivenData (microtask chain: effect -> doFetch -> dispatch). Under
  // a loaded `bun test` process the queue can take several flush cycles to
  // settle, so flush until the <diff> node appears (cap iterations).
  for (let i = 0; i < 20 && findNode(renderer.toJSON(), "diff") === undefined; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  return renderer;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("artifact diff rendering (#192)", () => {
  test("split mode renders the <diff> intrinsic, not hand-rolled text", async () => {
    const renderer = await renderDiff("split");
    const diffNode = findNode(renderer.toJSON(), "diff");
    expect(diffNode).toBeDefined();
    expect(diffNode?.props?.view).toBe("split");
    // The intrinsic consumes a unified-diff STRING via `diff`, not old/new content.
    expect(typeof diffNode?.props?.diff).toBe("string");
    expect(diffNode?.props?.oldContent).toBeUndefined();
    expect(diffNode?.props?.newContent).toBeUndefined();
    expect(diffNode?.props?.mode).toBeUndefined();
    renderer.unmount();
  });

  test("inline mode renders the <diff> intrinsic with view=unified", async () => {
    const renderer = await renderDiff("inline");
    const diffNode = findNode(renderer.toJSON(), "diff");
    expect(diffNode).toBeDefined();
    expect(diffNode?.props?.view).toBe("unified");
    expect(typeof diffNode?.props?.diff).toBe("string");
    renderer.unmount();
  });

  test("changing artifactIndex re-renders without error (pulse)", async () => {
    // The header accent pulse (useTimeline) keyed on artifactIndex must be
    // test-safe: all timeline calls live inside useEffect, so a plain
    // react-test-renderer mount + update is a no-op and must not throw.
    const names = ["a.txt", "b.txt"] as const;
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <ArtifactPreviewView
            provider={makeArtifactProvider()}
            cid="childcid01"
            artifactName="a.txt"
            allArtifactNames={names}
            artifactIndex={0}
            active
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
          <ArtifactPreviewView
            provider={makeArtifactProvider()}
            cid="childcid01"
            artifactName="b.txt"
            allArtifactNames={names}
            artifactIndex={1}
            active
          />
        ) as React.ReactElement,
      );
    });
    expect(renderer.toJSON()).toBeDefined();
    renderer.unmount();
  });
});

// ---------------------------------------------------------------------------
// computeUnifiedDiff parser-contract tests (C4)
//
// The <diff> intrinsic parses its `diff` string via the "diff" package's
// parsePatch, which REQUIRES a `@@ -a,b +c,d @@` hunk header and validates the
// declared line counts against the body. Without it, parsePatch THROWS and the
// diff view shows an error for every comparison. The "diff" package is not
// resolvable from grove test code via bare import, so we assert the invariants
// parsePatch checks structurally (header present; counts match body).
// ---------------------------------------------------------------------------

/** Split the diff into [labelLines, hunkHeader, bodyLines]. */
function splitDiff(out: string): {
  readonly labels: readonly string[];
  readonly header: string | undefined;
  readonly body: readonly string[];
} {
  const lines = out.split("\n");
  const headerIdx = lines.findIndex((l) => /^@@ /.test(l));
  return {
    labels: headerIdx >= 0 ? lines.slice(0, headerIdx) : lines,
    header: headerIdx >= 0 ? lines[headerIdx] : undefined,
    body: headerIdx >= 0 ? lines.slice(headerIdx + 1) : [],
  };
}

describe("computeUnifiedDiff parser contract (C4)", () => {
  test("differing inputs emit a valid @@ hunk header with counts matching the body", () => {
    const out = computeUnifiedDiff(
      "parent line\nshared\n",
      "child line\nshared\n",
      "parent",
      "child",
    );
    // Label lines preserved and in order, header after them.
    expect(out.startsWith("--- parent\n+++ child\n")).toBe(true);
    const { header, body } = splitDiff(out);
    expect(header).toBeDefined();
    const match = (header ?? "").match(/^@@ -1,(\d+) \+1,(\d+) @@$/);
    expect(match).not.toBeNull();
    const oldCount = Number(match?.[1]);
    const newCount = Number(match?.[2]);
    // parsePatch validates: declared old count == body lines that are context
    // or removals; declared new count == context or additions.
    const expectedOld = body.filter((l) => l.startsWith(" ") || l.startsWith("-")).length;
    const expectedNew = body.filter((l) => l.startsWith(" ") || l.startsWith("+")).length;
    expect(oldCount).toBe(expectedOld);
    expect(newCount).toBe(expectedNew);
  });

  test("identical inputs (only context lines) still emit a valid header", () => {
    const out = computeUnifiedDiff("a\nb\nc\n", "a\nb\nc\n", "p", "c");
    const { header, body } = splitDiff(out);
    expect(header).toBeDefined();
    const match = (header ?? "").match(/^@@ -1,(\d+) \+1,(\d+) @@$/);
    expect(match).not.toBeNull();
    // All body lines are context, so old == new == context count, and there
    // are no +/- lines.
    expect(body.every((l) => l.startsWith(" "))).toBe(true);
    const ctx = body.filter((l) => l.startsWith(" ")).length;
    expect(Number(match?.[1])).toBe(ctx);
    expect(Number(match?.[2])).toBe(ctx);
  });

  test("pure additions emit a valid header (old count = 0 context, new count = additions)", () => {
    const out = computeUnifiedDiff("", "x\ny\nz", "p", "c");
    const { header, body } = splitDiff(out);
    expect(header).toBeDefined();
    const match = (header ?? "").match(/^@@ -1,(\d+) \+1,(\d+) @@$/);
    expect(match).not.toBeNull();
    const expectedOld = body.filter((l) => l.startsWith(" ") || l.startsWith("-")).length;
    const expectedNew = body.filter((l) => l.startsWith(" ") || l.startsWith("+")).length;
    expect(Number(match?.[1])).toBe(expectedOld);
    expect(Number(match?.[2])).toBe(expectedNew);
  });

  test("oversized input is capped to MAX_DIFF_LINES with a visible truncation marker", () => {
    // 2500 distinct child lines (no parent) -> would be 2500 '+' lines uncapped.
    const big = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n");
    const out = computeUnifiedDiff("", big, "p", "c");
    const { header, body } = splitDiff(out);
    expect(header).toBeDefined();
    // A visible truncation marker is present in the body.
    expect(out).toContain("truncated");
    // Counts still match the actual emitted body (parsePatch validates this).
    const match = (header ?? "").match(/^@@ -1,(\d+) \+1,(\d+) @@$/);
    expect(match).not.toBeNull();
    const expectedOld = body.filter((l) => l.startsWith(" ") || l.startsWith("-")).length;
    const expectedNew = body.filter((l) => l.startsWith(" ") || l.startsWith("+")).length;
    expect(Number(match?.[1])).toBe(expectedOld);
    expect(Number(match?.[2])).toBe(expectedNew);
  });
});
