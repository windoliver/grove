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
import { ArtifactPreviewView } from "./artifact-preview.js";

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
  // Let the async fetcher resolve and flush effects.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
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
