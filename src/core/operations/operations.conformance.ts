/**
 * Conformance test suite for operations layer.
 *
 * Verifies that core operations return results matching the shared Zod schemas.
 * Any surface (CLI, MCP, HTTP) can invoke `runOperationConformanceTests()` with
 * a factory that supplies OperationDeps, confirming cross-surface response parity.
 *
 * Phase 5.2/5.3 — cross-surface conformance tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkoutOperation } from "./checkout.js";
import { claimOperation, listClaimsOperation, releaseOperation } from "./claim.js";
import {
  contributeOperation,
  discussOperation,
  reproduceOperation,
  reviewOperation,
} from "./contribute.js";
import type { OperationDeps } from "./deps.js";
import { checkStopOperation } from "./lifecycle.js";
import {
  frontierOperation,
  logOperation,
  searchOperation,
  threadOperation,
  threadsOperation,
  treeOperation,
} from "./query.js";
import {
  CheckoutResultSchema,
  CheckStopResultSchema,
  ClaimResultSchema,
  ContributeResultSchema,
  DiscussResultSchema,
  FrontierResultSchema,
  ListClaimsResultSchema,
  LogResultSchema,
  OperationErrSchema,
  ReleaseResultSchema,
  ReproduceResultSchema,
  ReviewResultSchema,
  SearchResultSchema,
  ThreadResultSchema,
  ThreadsResultSchema,
  TreeResultSchema,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// Factory type
// ---------------------------------------------------------------------------

/** Factory that creates fresh OperationDeps and returns a cleanup function. */
export type OperationDepsFactory = () => Promise<{
  deps: OperationDeps;
  cleanup: () => Promise<void>;
}>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate a successful result value against a Zod schema. */
function expectSchemaMatch<T>(
  schema: { parse: (v: unknown) => T },
  result: { readonly ok: boolean; readonly value?: unknown },
): void {
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // parse throws on mismatch — test fails with a descriptive ZodError
  schema.parse((result as { readonly value: unknown }).value);
}

/** Validate an error result against the OperationErrSchema. */
function expectErrSchemaMatch(result: { readonly ok: boolean; readonly error?: unknown }): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  OperationErrSchema.parse(result);
}

const NONEXISTENT_CID = "blake3:0000000000000000000000000000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// Conformance suite
// ---------------------------------------------------------------------------

/**
 * Run the full operations conformance test suite.
 *
 * Call this from any surface-specific test file with a factory that
 * creates and tears down OperationDeps instances.
 */
export function runOperationConformanceTests(factory: OperationDepsFactory): void {
  describe("Operations conformance", () => {
    let deps: OperationDeps;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const ctx = await factory();
      deps = ctx.deps;
      cleanup = ctx.cleanup;
    });

    afterEach(async () => {
      await cleanup();
    });

    // ----------------------------------------------------------------
    // Contribute operations
    // ----------------------------------------------------------------

    describe("contribute", () => {
      test("contributeOperation result matches ContributeResultSchema", async () => {
        const result = await contributeOperation(
          {
            kind: "work",
            summary: "Conformance test contribution",
            tags: ["conformance"],
            agent: { agentId: "conformance-agent" },
          },
          deps,
        );
        expectSchemaMatch(ContributeResultSchema, result);
      });

      test("contributeOperation with all optional fields matches schema", async () => {
        const result = await contributeOperation(
          {
            kind: "work",
            mode: "exploration",
            summary: "Full contribution",
            description: "A detailed description",
            tags: ["tag1", "tag2"],
            scores: { quality: { value: 0.9, direction: "maximize" } },
            context: { env: "test" },
            agent: { agentId: "agent-full" },
          },
          deps,
        );
        expectSchemaMatch(ContributeResultSchema, result);
      });

      test("contributeOperation invalid relation returns error matching schema", async () => {
        const result = await contributeOperation(
          {
            kind: "work",
            summary: "Bad relation",
            relations: [{ targetCid: NONEXISTENT_CID, relationType: "derives_from" }],
            agent: { agentId: "agent-err" },
          },
          deps,
        );
        expectErrSchemaMatch(result);
        if (!result.ok) {
          expect(result.error.code).toBe("NOT_FOUND");
        }
      });

      test("reviewOperation result matches ReviewResultSchema", async () => {
        const target = await contributeOperation(
          { kind: "work", summary: "target", agent: { agentId: "a1" } },
          deps,
        );
        expect(target.ok).toBe(true);
        if (!target.ok) return;

        const result = await reviewOperation(
          {
            targetCid: target.value.cid,
            summary: "Conformance review",
            agent: { agentId: "reviewer" },
          },
          deps,
        );
        expectSchemaMatch(ReviewResultSchema, result);
      });

      test("reviewOperation not-found target matches error schema", async () => {
        const result = await reviewOperation(
          {
            targetCid: NONEXISTENT_CID,
            summary: "Review of nothing",
            agent: { agentId: "reviewer" },
          },
          deps,
        );
        expectErrSchemaMatch(result);
        if (!result.ok) {
          expect(result.error.code).toBe("NOT_FOUND");
        }
      });

      test("reproduceOperation result matches ReproduceResultSchema", async () => {
        const target = await contributeOperation(
          { kind: "work", summary: "target", agent: { agentId: "a1" } },
          deps,
        );
        expect(target.ok).toBe(true);
        if (!target.ok) return;

        const result = await reproduceOperation(
          {
            targetCid: target.value.cid,
            summary: "Conformance reproduction",
            result: "confirmed",
            agent: { agentId: "reproducer" },
          },
          deps,
        );
        expectSchemaMatch(ReproduceResultSchema, result);
      });

      test("discussOperation result matches DiscussResultSchema", async () => {
        const result = await discussOperation(
          {
            summary: "Conformance discussion",
            agent: { agentId: "discusser" },
          },
          deps,
        );
        expectSchemaMatch(DiscussResultSchema, result);
      });

      test("discussOperation reply result matches DiscussResultSchema", async () => {
        const root = await discussOperation(
          { summary: "Root topic", agent: { agentId: "a1" } },
          deps,
        );
        expect(root.ok).toBe(true);
        if (!root.ok) return;

        const reply = await discussOperation(
          {
            targetCid: root.value.cid,
            summary: "Reply",
            agent: { agentId: "a2" },
          },
          deps,
        );
        expectSchemaMatch(DiscussResultSchema, reply);
        if (reply.ok) {
          expect(reply.value.targetCid).toBe(root.value.cid);
        }
      });
    });

    // ----------------------------------------------------------------
    // Claim operations
    // ----------------------------------------------------------------

    describe("claim", () => {
      test("claimOperation result matches ClaimResultSchema", async () => {
        const result = await claimOperation(
          {
            targetRef: "conformance-task-1",
            intentSummary: "Conformance claim",
            agent: { agentId: "claim-agent" },
          },
          deps,
        );
        expectSchemaMatch(ClaimResultSchema, result);
        if (result.ok) {
          expect(result.value.renewed).toBe(false);
        }
      });

      test("claimOperation renewal matches ClaimResultSchema", async () => {
        await claimOperation(
          {
            targetRef: "task-renew",
            intentSummary: "First",
            agent: { agentId: "agent-renew" },
          },
          deps,
        );

        const result = await claimOperation(
          {
            targetRef: "task-renew",
            intentSummary: "Renewed",
            agent: { agentId: "agent-renew" },
          },
          deps,
        );
        expectSchemaMatch(ClaimResultSchema, result);
        if (result.ok) {
          expect(result.value.renewed).toBe(true);
        }
      });

      test("claimOperation conflict matches error schema", async () => {
        await claimOperation(
          {
            targetRef: "conflict-task",
            intentSummary: "Agent 1",
            agent: { agentId: "agent-1" },
          },
          deps,
        );

        const result = await claimOperation(
          {
            targetRef: "conflict-task",
            intentSummary: "Agent 2",
            agent: { agentId: "agent-2" },
          },
          deps,
        );
        expectErrSchemaMatch(result);
        if (!result.ok) {
          expect(result.error.code).toBe("CLAIM_CONFLICT");
        }
      });

      test("releaseOperation result matches ReleaseResultSchema", async () => {
        const claim = await claimOperation(
          {
            targetRef: "release-task",
            intentSummary: "To be released",
            agent: { agentId: "agent-release" },
          },
          deps,
        );
        expect(claim.ok).toBe(true);
        if (!claim.ok) return;

        const result = await releaseOperation(
          { claimId: claim.value.claimId, action: "release" },
          deps,
        );
        expectSchemaMatch(ReleaseResultSchema, result);
        if (result.ok) {
          expect(result.value.action).toBe("release");
          expect(result.value.status).toBe("released");
        }
      });

      test("releaseOperation complete matches ReleaseResultSchema", async () => {
        const claim = await claimOperation(
          {
            targetRef: "complete-task",
            intentSummary: "To be completed",
            agent: { agentId: "agent-complete" },
          },
          deps,
        );
        expect(claim.ok).toBe(true);
        if (!claim.ok) return;

        const result = await releaseOperation(
          { claimId: claim.value.claimId, action: "complete" },
          deps,
        );
        expectSchemaMatch(ReleaseResultSchema, result);
        if (result.ok) {
          expect(result.value.action).toBe("complete");
          expect(result.value.status).toBe("completed");
        }
      });

      test("releaseOperation not-found matches error schema", async () => {
        const result = await releaseOperation(
          { claimId: "nonexistent-claim", action: "release" },
          deps,
        );
        expectErrSchemaMatch(result);
        if (!result.ok) {
          expect(result.error.code).toBe("NOT_FOUND");
        }
      });

      test("listClaimsOperation empty result matches ListClaimsResultSchema", async () => {
        const result = await listClaimsOperation({}, deps);
        expectSchemaMatch(ListClaimsResultSchema, result);
        if (result.ok) {
          expect(result.value.count).toBe(0);
          expect(result.value.claims).toHaveLength(0);
        }
      });

      test("listClaimsOperation with claims matches ListClaimsResultSchema", async () => {
        await claimOperation(
          {
            targetRef: "list-task-1",
            intentSummary: "Task 1",
            agent: { agentId: "a1" },
          },
          deps,
        );
        await claimOperation(
          {
            targetRef: "list-task-2",
            intentSummary: "Task 2",
            agent: { agentId: "a2" },
          },
          deps,
        );

        const result = await listClaimsOperation({}, deps);
        expectSchemaMatch(ListClaimsResultSchema, result);
        if (result.ok) {
          expect(result.value.count).toBe(2);
        }
      });
    });

    // ----------------------------------------------------------------
    // Query operations
    // ----------------------------------------------------------------

    describe("query", () => {
      test("frontierOperation empty matches FrontierResultSchema", async () => {
        const result = await frontierOperation({}, deps);
        expectSchemaMatch(FrontierResultSchema, result);
      });

      test("frontierOperation with contributions matches FrontierResultSchema", async () => {
        await contributeOperation(
          {
            kind: "work",
            summary: "frontier item",
            scores: { val_bpb: { value: 0.9, direction: "minimize" } },
            agent: { agentId: "a1" },
          },
          deps,
        );

        const result = await frontierOperation({ metric: "val_bpb" }, deps);
        expectSchemaMatch(FrontierResultSchema, result);
      });

      test("searchOperation matches SearchResultSchema", async () => {
        await contributeOperation(
          {
            kind: "work",
            summary: "searchable neural network",
            agent: { agentId: "a1" },
          },
          deps,
        );

        const result = await searchOperation({ query: "neural" }, deps);
        expectSchemaMatch(SearchResultSchema, result);
        if (result.ok) {
          expect(result.value.count).toBeGreaterThan(0);
        }
      });

      test("searchOperation no match matches SearchResultSchema", async () => {
        const result = await searchOperation({ query: "nonexistent" }, deps);
        expectSchemaMatch(SearchResultSchema, result);
        if (result.ok) {
          expect(result.value.count).toBe(0);
        }
      });

      test("logOperation matches LogResultSchema", async () => {
        await contributeOperation(
          { kind: "work", summary: "log entry 1", agent: { agentId: "a1" } },
          deps,
        );
        await contributeOperation(
          { kind: "work", summary: "log entry 2", agent: { agentId: "a1" } },
          deps,
        );

        const result = await logOperation({}, deps);
        expectSchemaMatch(LogResultSchema, result);
        if (result.ok) {
          expect(result.value.count).toBe(2);
          // Newest first
          expect(result.value.results[0]?.summary).toBe("log entry 2");
        }
      });

      test("treeOperation matches TreeResultSchema", async () => {
        const parent = await contributeOperation(
          { kind: "work", summary: "tree parent", agent: { agentId: "a1" } },
          deps,
        );
        expect(parent.ok).toBe(true);
        if (!parent.ok) return;

        await contributeOperation(
          {
            kind: "work",
            summary: "tree child",
            relations: [{ targetCid: parent.value.cid, relationType: "derives_from" }],
            agent: { agentId: "a1" },
          },
          deps,
        );

        const result = await treeOperation({ cid: parent.value.cid, direction: "both" }, deps);
        expectSchemaMatch(TreeResultSchema, result);
        if (result.ok) {
          expect(result.value.children).toBeDefined();
          expect(result.value.ancestors).toBeDefined();
        }
      });

      test("treeOperation not-found matches error schema", async () => {
        const result = await treeOperation({ cid: NONEXISTENT_CID }, deps);
        expectErrSchemaMatch(result);
        if (!result.ok) {
          expect(result.error.code).toBe("NOT_FOUND");
        }
      });

      test("threadOperation matches ThreadResultSchema", async () => {
        const root = await discussOperation(
          { summary: "Thread root", agent: { agentId: "a1" } },
          deps,
        );
        expect(root.ok).toBe(true);
        if (!root.ok) return;

        await discussOperation(
          {
            targetCid: root.value.cid,
            summary: "Thread reply",
            agent: { agentId: "a2" },
          },
          deps,
        );

        const result = await threadOperation({ cid: root.value.cid }, deps);
        expectSchemaMatch(ThreadResultSchema, result);
        if (result.ok) {
          expect(result.value.count).toBe(2);
        }
      });

      test("threadOperation not-found matches error schema", async () => {
        const result = await threadOperation({ cid: NONEXISTENT_CID }, deps);
        expectErrSchemaMatch(result);
        if (!result.ok) {
          expect(result.error.code).toBe("NOT_FOUND");
        }
      });

      test("threadsOperation matches ThreadsResultSchema", async () => {
        const root = await discussOperation(
          { summary: "Hot thread", agent: { agentId: "a1" } },
          deps,
        );
        expect(root.ok).toBe(true);
        if (!root.ok) return;

        await discussOperation(
          {
            targetCid: root.value.cid,
            summary: "Reply 1",
            agent: { agentId: "a2" },
          },
          deps,
        );

        const result = await threadsOperation({}, deps);
        expectSchemaMatch(ThreadsResultSchema, result);
      });

      test("threadsOperation empty matches ThreadsResultSchema", async () => {
        const result = await threadsOperation({}, deps);
        expectSchemaMatch(ThreadsResultSchema, result);
        if (result.ok) {
          expect(result.value.count).toBe(0);
        }
      });
    });

    // ----------------------------------------------------------------
    // Checkout operations
    // ----------------------------------------------------------------

    describe("checkout", () => {
      test("checkoutOperation result matches CheckoutResultSchema", async () => {
        const contrib = await contributeOperation(
          {
            kind: "work",
            summary: "Checkout conformance",
            agent: { agentId: "checkout-agent" },
          },
          deps,
        );
        expect(contrib.ok).toBe(true);
        if (!contrib.ok) return;

        const result = await checkoutOperation(
          { cid: contrib.value.cid, agent: { agentId: "checkout-agent" } },
          deps,
        );
        expectSchemaMatch(CheckoutResultSchema, result);
      });

      test("checkoutOperation not-found matches error schema", async () => {
        const result = await checkoutOperation(
          { cid: NONEXISTENT_CID, agent: { agentId: "agent-1" } },
          deps,
        );
        expectErrSchemaMatch(result);
        if (!result.ok) {
          expect(result.error.code).toBe("NOT_FOUND");
        }
      });

      test("checkoutOperation without workspace matches error schema", async () => {
        const depsWithoutWorkspace: OperationDeps = {
          contributionStore: deps.contributionStore,
          claimStore: deps.claimStore,
          cas: deps.cas,
          frontier: deps.frontier,
        };

        const result = await checkoutOperation(
          { cid: NONEXISTENT_CID, agent: { agentId: "agent-1" } },
          depsWithoutWorkspace,
        );
        expectErrSchemaMatch(result);
        if (!result.ok) {
          expect(result.error.code).toBe("VALIDATION_ERROR");
        }
      });
    });

    // ----------------------------------------------------------------
    // Lifecycle operations
    // ----------------------------------------------------------------

    describe("lifecycle", () => {
      test("checkStopOperation without contract matches CheckStopResultSchema", async () => {
        const result = await checkStopOperation(deps);
        expectSchemaMatch(CheckStopResultSchema, result);
        if (result.ok) {
          expect(result.value.stopped).toBe(false);
        }
      });
    });
  });
}
