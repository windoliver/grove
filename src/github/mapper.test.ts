/**
 * Tests for GitHub ↔ Contribution mapper functions.
 */

import { describe, expect, test } from "bun:test";
import type { Contribution } from "../core/models.js";
import { ContributionKind, ContributionMode, RelationType } from "../core/models.js";
import {
  contributionToDiscussionBody,
  contributionToPRBody,
  discussionToContributionInput,
  prToContributionInput,
} from "./mapper.js";
import {
  makeTestComment,
  makeTestDiscussion,
  makeTestDiscussionComment,
  makeTestPR,
  makeTestPRFile,
  makeTestReviewComment,
} from "./testing.js";

// ---------------------------------------------------------------------------
// Contribution → Discussion
// ---------------------------------------------------------------------------

describe("contributionToDiscussionBody", () => {
  const baseContribution = {
    cid: "blake3:abc123def456",
    kind: "work",
    mode: "evaluation",
    summary: "Improve model accuracy by 5%",
    tags: [] as string[],
    relations: [],
    artifacts: {},
    agent: { agentId: "test", agentName: "claude", provider: "anthropic", model: "opus-4" },
    createdAt: "2025-06-01T12:00:00Z",
    manifestVersion: 1,
  } satisfies Contribution;

  test("includes summary in body", () => {
    const result = contributionToDiscussionBody(baseContribution);
    expect(result.body).toContain("Improve model accuracy by 5%");
  });

  test("includes CID in provenance footer", () => {
    const result = contributionToDiscussionBody(baseContribution);
    expect(result.body).toContain("`blake3:abc123def456`");
  });

  test("includes 'generated from Grove contribution' marker", () => {
    const result = contributionToDiscussionBody(baseContribution);
    expect(result.body).toContain("generated from Grove contribution");
  });

  test("formats title with kind prefix", () => {
    const result = contributionToDiscussionBody(baseContribution);
    expect(result.title).toBe("[grove:work] Improve model accuracy by 5%");
  });

  test("includes description when present", () => {
    const result = contributionToDiscussionBody({
      ...baseContribution,
      description: "Detailed explanation of changes",
    });
    expect(result.body).toContain("Detailed explanation of changes");
  });

  test("includes scores table", () => {
    const result = contributionToDiscussionBody({
      ...baseContribution,
      scores: {
        val_bpb: { value: 1.23, direction: "minimize", unit: "bits/byte" },
        accuracy: { value: 0.95, direction: "maximize" },
      },
    });
    expect(result.body).toContain("| Metric | Value | Direction | Unit |");
    expect(result.body).toContain("| val_bpb | 1.23 | minimize | bits/byte |");
    expect(result.body).toContain("| accuracy | 0.95 | maximize | — |");
  });

  test("includes tags", () => {
    const result = contributionToDiscussionBody({
      ...baseContribution,
      tags: ["ml", "optimization"],
    });
    expect(result.body).toContain("**Tags:** ml, optimization");
  });

  test("includes relations", () => {
    const result = contributionToDiscussionBody({
      ...baseContribution,
      relations: [
        { targetCid: "blake3:parent1", relationType: RelationType.DerivesFrom },
        { targetCid: "blake3:reviewed", relationType: RelationType.Reviews },
      ],
    });
    expect(result.body).toContain("Derives from `blake3:parent1`");
    expect(result.body).toContain("Reviews `blake3:reviewed`");
  });

  test("includes agent info", () => {
    const result = contributionToDiscussionBody(baseContribution);
    expect(result.body).toContain("**Agent:** claude / anthropic / opus-4");
  });

  test("truncates title at 256 chars", () => {
    const longSummary = "A".repeat(300);
    const result = contributionToDiscussionBody({
      ...baseContribution,
      summary: longSummary,
    });
    expect(result.title.length).toBeLessThanOrEqual(256);
    expect(result.title).toEndWith("...");
  });

  test("handles empty tags and relations", () => {
    const result = contributionToDiscussionBody(baseContribution);
    expect(result.body).not.toContain("**Tags:**");
    expect(result.body).not.toContain("## Relations");
  });

  test("handles agent with no name/provider/model", () => {
    const result = contributionToDiscussionBody({
      ...baseContribution,
      agent: { agentId: "test" },
    });
    expect(result.body).not.toContain("**Agent:**");
  });
});

// ---------------------------------------------------------------------------
// Contribution → PR
// ---------------------------------------------------------------------------

describe("contributionToPRBody", () => {
  const baseContribution = {
    cid: "blake3:abc123def456",
    kind: "work",
    mode: "evaluation",
    summary: "Add feature X",
    tags: [] as string[],
    relations: [],
    artifacts: {},
    agent: { agentId: "test", agentName: "claude" },
    createdAt: "2025-06-01T12:00:00Z",
    manifestVersion: 1,
  } satisfies Contribution;

  test("formats title with kind prefix", () => {
    const result = contributionToPRBody(baseContribution);
    expect(result.title).toBe("[grove:work] Add feature X");
  });

  test("includes summary in body", () => {
    const result = contributionToPRBody(baseContribution);
    expect(result.body).toContain("Add feature X");
  });

  test("includes 'generated from Grove contribution' marker", () => {
    const result = contributionToPRBody(baseContribution);
    expect(result.body).toContain("generated from Grove contribution");
  });

  test("includes NOT for merging note", () => {
    const result = contributionToPRBody(baseContribution);
    expect(result.body).toContain("NOT created for merging");
  });

  test("generates branch name from CID", () => {
    const result = contributionToPRBody(baseContribution);
    expect(result.branchName).toBe("grove/work/abc123def456");
  });

  test("includes description when present", () => {
    const result = contributionToPRBody({
      ...baseContribution,
      description: "Detailed changes",
    });
    expect(result.body).toContain("## Description");
    expect(result.body).toContain("Detailed changes");
  });

  test("includes tags", () => {
    const result = contributionToPRBody({
      ...baseContribution,
      tags: ["feature", "core"],
    });
    expect(result.body).toContain("**Tags:** feature, core");
  });

  test("truncates title at 256 chars", () => {
    const result = contributionToPRBody({
      ...baseContribution,
      summary: "B".repeat(300),
    });
    expect(result.title.length).toBeLessThanOrEqual(256);
  });
});

// ---------------------------------------------------------------------------
// PR → Contribution
// ---------------------------------------------------------------------------

describe("prToContributionInput", () => {
  test("creates work contribution from PR", () => {
    const pr = makeTestPR({ title: "Fix bug", body: "Details here" });
    const input = prToContributionInput(pr, {
      repoRef: "owner/repo",
      artifacts: { diff: "blake3:diffhash" },
      agent: { agentId: "agent-1", agentName: "grove-import" },
    });

    expect(input.kind).toBe(ContributionKind.Work);
    expect(input.mode).toBe(ContributionMode.Exploration);
    expect(input.summary).toContain("GitHub PR #1");
    expect(input.summary).toContain("Fix bug");
    expect(input.description).toBe("Details here");
    expect(input.artifacts).toEqual({ diff: "blake3:diffhash" });
    expect(input.tags).toContain("github-import");
    expect(input.tags).toContain("pull-request");
  });

  test("preserves PR metadata in context.github", () => {
    const pr = makeTestPR({
      number: 44,
      author: "alice",
      state: "open",
      url: "https://github.com/o/r/pull/44",
      baseBranch: "main",
      headBranch: "feature",
    });
    const input = prToContributionInput(pr, {
      repoRef: "o/r",
      artifacts: {},
      agent: { agentId: "a1", agentName: "test" },
    });

    const gh = input.context?.github as Record<string, unknown>;
    expect(gh.type).toBe("pull_request");
    expect(gh.repo).toBe("o/r");
    expect(gh.number).toBe(44);
    expect(gh.author).toBe("alice");
    expect(gh.state).toBe("open");
    expect(gh.baseBranch).toBe("main");
    expect(gh.headBranch).toBe("feature");
  });

  test("includes comments in context", () => {
    const pr = makeTestPR({
      comments: [makeTestComment({ id: "c1", body: "Looks good" })],
    });
    const input = prToContributionInput(pr, {
      repoRef: "o/r",
      artifacts: {},
      agent: { agentId: "a1", agentName: "test" },
    });

    const gh = input.context?.github as Record<string, unknown>;
    const comments = gh.comments as Array<Record<string, unknown>>;
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe("Looks good");
  });

  test("includes review comments in context", () => {
    const pr = makeTestPR({
      reviewComments: [
        makeTestReviewComment({ id: "rc1", body: "Nit", path: "src/x.ts", line: 10 }),
      ],
    });
    const input = prToContributionInput(pr, {
      repoRef: "o/r",
      artifacts: {},
      agent: { agentId: "a1", agentName: "test" },
    });

    const gh = input.context?.github as Record<string, unknown>;
    const rcs = gh.reviewComments as Array<Record<string, unknown>>;
    expect(rcs).toHaveLength(1);
    expect(rcs[0]?.path).toBe("src/x.ts");
    expect(rcs[0]?.line).toBe(10);
  });

  test("handles PR with empty body", () => {
    const pr = makeTestPR({ body: "" });
    const input = prToContributionInput(pr, {
      repoRef: "o/r",
      artifacts: {},
      agent: { agentId: "a1", agentName: "test" },
    });
    expect(input.description).toBeUndefined();
  });

  test("includes file count in context", () => {
    const pr = makeTestPR({
      files: [makeTestPRFile({ filename: "a.ts" }), makeTestPRFile({ filename: "b.ts" })],
    });
    const input = prToContributionInput(pr, {
      repoRef: "o/r",
      artifacts: {},
      agent: { agentId: "a1", agentName: "test" },
    });

    const gh = input.context?.github as Record<string, unknown>;
    expect(gh.filesChanged).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Discussion → Contribution
// ---------------------------------------------------------------------------

describe("discussionToContributionInput", () => {
  test("creates discussion contribution", () => {
    const disc = makeTestDiscussion({
      number: 43,
      title: "RFC: New approach",
      body: "Let's discuss this",
    });
    const input = discussionToContributionInput(disc, {
      repoRef: "o/r",
      agent: { agentId: "a1", agentName: "test" },
    });

    expect(input.kind).toBe(ContributionKind.Discussion);
    expect(input.mode).toBe(ContributionMode.Exploration);
    expect(input.summary).toContain("GitHub Discussion #43");
    expect(input.summary).toContain("RFC: New approach");
    expect(input.description).toBe("Let's discuss this");
    expect(input.tags).toContain("github-import");
    expect(input.tags).toContain("discussion");
  });

  test("preserves discussion metadata in context.github", () => {
    const disc = makeTestDiscussion({
      number: 10,
      author: "bob",
      categoryName: "Ideas",
      url: "https://github.com/o/r/discussions/10",
    });
    const input = discussionToContributionInput(disc, {
      repoRef: "o/r",
      agent: { agentId: "a1", agentName: "test" },
    });

    const gh = input.context?.github as Record<string, unknown>;
    expect(gh.type).toBe("discussion");
    expect(gh.number).toBe(10);
    expect(gh.author).toBe("bob");
    expect(gh.categoryName).toBe("Ideas");
  });

  test("includes comments and replies in context", () => {
    const disc = makeTestDiscussion({
      comments: [
        makeTestDiscussionComment({
          id: "dc1",
          body: "Good point",
          isAnswer: true,
          replies: [makeTestComment({ id: "r1", body: "Thanks" })],
        }),
      ],
    });
    const input = discussionToContributionInput(disc, {
      repoRef: "o/r",
      agent: { agentId: "a1", agentName: "test" },
    });

    const gh = input.context?.github as Record<string, unknown>;
    const comments = gh.comments as Array<Record<string, unknown>>;
    expect(comments).toHaveLength(1);
    expect(comments[0]?.isAnswer).toBe(true);
    const replies = comments[0]?.replies as Array<Record<string, unknown>>;
    expect(replies).toHaveLength(1);
    expect(replies[0]?.body).toBe("Thanks");
  });

  test("handles discussion with empty body", () => {
    const disc = makeTestDiscussion({ body: "" });
    const input = discussionToContributionInput(disc, {
      repoRef: "o/r",
      agent: { agentId: "a1", agentName: "test" },
    });
    expect(input.description).toBeUndefined();
  });

  test("has empty artifacts", () => {
    const disc = makeTestDiscussion();
    const input = discussionToContributionInput(disc, {
      repoRef: "o/r",
      agent: { agentId: "a1", agentName: "test" },
    });
    expect(Object.keys(input.artifacts)).toHaveLength(0);
  });
});
