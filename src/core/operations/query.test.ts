/**
 * Tests for query operations.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { contributeOperation, discussOperation } from "./contribute.js";
import type { OperationDeps } from "./deps.js";
import {
  frontierOperation,
  logOperation,
  searchOperation,
  threadOperation,
  threadsOperation,
  treeOperation,
} from "./query.js";
import type { TestOperationDeps } from "./test-helpers.js";
import { createTestOperationDeps } from "./test-helpers.js";

describe("frontierOperation", () => {
  let testDeps: TestOperationDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("returns empty frontier when no contributions exist", async () => {
    const result = await frontierOperation({}, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.byRecency).toHaveLength(0);
    expect(result.value.byAdoption).toHaveLength(0);
    expect(result.value.byReviewScore).toHaveLength(0);
    expect(result.value.byReproduction).toHaveLength(0);
  });

  test("returns contributions ranked by recency", async () => {
    await contributeOperation({ kind: "work", summary: "first", agent: { agentId: "a1" } }, deps);
    await contributeOperation({ kind: "work", summary: "second", agent: { agentId: "a1" } }, deps);

    const result = await frontierOperation({}, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.byRecency.length).toBeGreaterThanOrEqual(2);
    // Most recent first
    expect(result.value.byRecency[0]?.summary).toBe("second");
  });

  test("returns metric-based frontier for scored contributions", async () => {
    await contributeOperation(
      {
        kind: "work",
        summary: "good score",
        scores: { val_bpb: { value: 0.95, direction: "minimize" } },
        agent: { agentId: "a1" },
      },
      deps,
    );
    await contributeOperation(
      {
        kind: "work",
        summary: "better score",
        scores: { val_bpb: { value: 0.9, direction: "minimize" } },
        agent: { agentId: "a1" },
      },
      deps,
    );

    const result = await frontierOperation({ metric: "val_bpb" }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const valBpb = result.value.byMetric.val_bpb;
    expect(valBpb).toBeDefined();
    expect(valBpb?.length).toBe(2);
    // Lower is better for minimize
    expect(valBpb?.[0]?.summary).toBe("better score");
  });

  test("respects limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await contributeOperation(
        { kind: "work", summary: `contrib ${i}`, agent: { agentId: "a1" } },
        deps,
      );
    }

    const result = await frontierOperation({ limit: 2 }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.byRecency.length).toBeLessThanOrEqual(2);
  });
});

describe("searchOperation", () => {
  let testDeps: TestOperationDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("returns matching contributions", async () => {
    await contributeOperation(
      { kind: "work", summary: "neural network training", agent: { agentId: "a1" } },
      deps,
    );
    await contributeOperation(
      { kind: "work", summary: "database optimization", agent: { agentId: "a1" } },
      deps,
    );

    const result = await searchOperation({ query: "neural" }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBe(1);
    expect(result.value.results[0]?.summary).toContain("neural");
  });

  test("returns empty results for no matches", async () => {
    await contributeOperation(
      { kind: "work", summary: "hello world", agent: { agentId: "a1" } },
      deps,
    );

    const result = await searchOperation({ query: "nonexistent" }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBe(0);
  });
});

describe("logOperation", () => {
  let testDeps: TestOperationDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("returns contributions newest first", async () => {
    await contributeOperation({ kind: "work", summary: "first", agent: { agentId: "a1" } }, deps);
    await contributeOperation({ kind: "work", summary: "second", agent: { agentId: "a1" } }, deps);

    const result = await logOperation({}, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBe(2);
    expect(result.value.results[0]?.summary).toBe("second");
    expect(result.value.results[1]?.summary).toBe("first");
  });

  test("filters by kind", async () => {
    await contributeOperation({ kind: "work", summary: "work", agent: { agentId: "a1" } }, deps);
    await discussOperation({ summary: "discussion", agent: { agentId: "a1" } }, deps);

    const result = await logOperation({ kind: "work" }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBe(1);
    expect(result.value.results[0]?.kind).toBe("work");
  });

  test("respects limit and offset", async () => {
    for (let i = 0; i < 5; i++) {
      await contributeOperation(
        { kind: "work", summary: `entry ${i}`, agent: { agentId: "a1" } },
        deps,
      );
    }

    const result = await logOperation({ limit: 2 }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBe(2);
  });
});

describe("treeOperation", () => {
  let testDeps: TestOperationDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("returns children and ancestors for a contribution", async () => {
    const parent = await contributeOperation(
      { kind: "work", summary: "parent", agent: { agentId: "a1" } },
      deps,
    );
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;

    const child = await contributeOperation(
      {
        kind: "work",
        summary: "child",
        relations: [{ targetCid: parent.value.cid, relationType: "derives_from" }],
        agent: { agentId: "a1" },
      },
      deps,
    );
    expect(child.ok).toBe(true);

    const result = await treeOperation({ cid: parent.value.cid, direction: "both" }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cid).toBe(parent.value.cid);
    expect(result.value.children).toBeDefined();
    expect(result.value.children?.length).toBe(1);
    expect(result.value.children?.[0]?.summary).toBe("child");
    expect(result.value.ancestors).toBeDefined();
  });

  test("returns NOT_FOUND for unknown CID", async () => {
    const result = await treeOperation(
      { cid: "blake3:0000000000000000000000000000000000000000000000000000000000000000" },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  test("only children direction", async () => {
    const parent = await contributeOperation(
      { kind: "work", summary: "parent", agent: { agentId: "a1" } },
      deps,
    );
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;

    const result = await treeOperation({ cid: parent.value.cid, direction: "children" }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.children).toBeDefined();
    expect(result.value.ancestors).toBeUndefined();
  });
});

describe("threadOperation", () => {
  let testDeps: TestOperationDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("returns a thread with depth metadata", async () => {
    // Root discussion
    const root = await discussOperation(
      { summary: "Topic: testing", agent: { agentId: "a1" } },
      deps,
    );
    expect(root.ok).toBe(true);
    if (!root.ok) return;

    // Reply
    await discussOperation(
      {
        targetCid: root.value.cid,
        summary: "I agree",
        agent: { agentId: "a2" },
      },
      deps,
    );

    const result = await threadOperation({ cid: root.value.cid }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBe(2);
    expect(result.value.nodes[0]?.depth).toBe(0);
    expect(result.value.nodes[0]?.summary).toBe("Topic: testing");
    expect(result.value.nodes[1]?.depth).toBe(1);
    expect(result.value.nodes[1]?.summary).toBe("I agree");
  });

  test("returns NOT_FOUND for unknown root", async () => {
    const result = await threadOperation(
      { cid: "blake3:0000000000000000000000000000000000000000000000000000000000000000" },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });
});

describe("threadsOperation", () => {
  let testDeps: TestOperationDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("returns hot threads ranked by reply count", async () => {
    // Create root
    const root = await discussOperation({ summary: "Hot topic", agent: { agentId: "a1" } }, deps);
    expect(root.ok).toBe(true);
    if (!root.ok) return;

    // Add replies
    await discussOperation(
      { targetCid: root.value.cid, summary: "Reply 1", agent: { agentId: "a2" } },
      deps,
    );
    await discussOperation(
      { targetCid: root.value.cid, summary: "Reply 2", agent: { agentId: "a3" } },
      deps,
    );

    const result = await threadsOperation({}, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBeGreaterThanOrEqual(1);
    expect(result.value.threads[0]?.replyCount).toBe(2);
  });

  test("returns empty when no threads exist", async () => {
    const result = await threadsOperation({}, deps);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.count).toBe(0);
  });
});
