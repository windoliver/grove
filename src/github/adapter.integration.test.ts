/**
 * Integration tests for the GitHub adapter.
 *
 * Uses real SQLite store + filesystem CAS + InMemoryGitHubClient.
 * Validates the full flow from store → adapter → GitHub mock → store.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContribution } from "../core/manifest.js";
import { ContributionKind, ContributionMode, ScoreDirection } from "../core/models.js";
import { FsCas } from "../local/fs-cas.js";
import { createSqliteStores } from "../local/sqlite-store.js";
import { createGitHubAdapter } from "./adapter.js";
import {
  InMemoryGitHubClient,
  makeTestComment,
  makeTestDiscussion,
  makeTestDiscussionComment,
  makeTestPR,
  makeTestPRFile,
  makeTestReviewComment,
} from "./testing.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let tmpDir: string;
let stores: ReturnType<typeof createSqliteStores>;
let cas: FsCas;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "grove-gh-int-"));
  stores = createSqliteStores(join(tmpDir, "grove.db"));
  cas = new FsCas(join(tmpDir, "cas"));
});

afterEach(async () => {
  stores.close();
  cas.close();
  await rm(tmpDir, { recursive: true, force: true });
});

const testAgent = { agentId: "integration-agent", agentName: "grove-test" };

// ---------------------------------------------------------------------------
// Full round-trip: export → verify GitHub state
// ---------------------------------------------------------------------------

describe("integration: export to Discussion", () => {
  test("full flow with SQLite store and filesystem CAS", async () => {
    const client = new InMemoryGitHubClient();
    const repo = { owner: "alice", repo: "research" };
    client.seedRepo(repo, {
      categories: [{ id: "cat-1", name: "Results" }],
    });

    // Create a contribution with scores and store it
    const contribution = createContribution({
      kind: ContributionKind.Work,
      mode: ContributionMode.Evaluation,
      summary: "Achieved 1.5 bpb on validation set",
      description: "Used new architecture with attention modifications",
      artifacts: {},
      relations: [],
      scores: {
        val_bpb: { value: 1.5, direction: ScoreDirection.Minimize, unit: "bits/byte" },
      },
      tags: ["ml", "transformer"],
      agent: testAgent,
      createdAt: "2025-06-01T12:00:00Z",
    });
    await stores.contributionStore.put(contribution);

    const adapter = createGitHubAdapter({
      client,
      store: stores.contributionStore,
      cas,
      agent: testAgent,
    });

    const result = await adapter.exportToDiscussion(repo, contribution.cid, "Results");

    expect(result.url).toContain("discussions");
    expect(result.discussionNumber).toBeGreaterThan(0);

    // Verify discussion content
    const disc = await client.getDiscussion({
      ...repo,
      number: result.discussionNumber,
    });
    expect(disc.title).toContain("grove:work");
    expect(disc.body).toContain("1.5 bpb");
    expect(disc.body).toContain(contribution.cid);
    expect(disc.body).toContain("generated from Grove contribution");
  });
});

describe("integration: export to PR", () => {
  test("full flow with artifacts from filesystem CAS", async () => {
    const client = new InMemoryGitHubClient();
    const repo = { owner: "alice", repo: "project" };
    client.seedRepo(repo);

    // Store a file in CAS
    const fileContent = new TextEncoder().encode("export const hello = 'world';");
    const hash = await cas.put(fileContent, { mediaType: "text/typescript" });

    // Create contribution referencing the artifact
    const contribution = createContribution({
      kind: ContributionKind.Work,
      mode: ContributionMode.Exploration,
      summary: "Add hello module",
      artifacts: { "src/hello.ts": hash },
      relations: [],
      tags: ["feature"],
      agent: testAgent,
      createdAt: "2025-06-01T12:00:00Z",
    });
    await stores.contributionStore.put(contribution);

    const adapter = createGitHubAdapter({
      client,
      store: stores.contributionStore,
      cas,
      agent: testAgent,
    });

    const result = await adapter.exportToPR(repo, contribution.cid);

    expect(result.url).toContain("pull");
    expect(result.prNumber).toBeGreaterThan(0);

    // Verify branch was pushed with the artifact
    const branches = client.getPushedBranches(repo);
    expect(branches.size).toBe(1);
    const [, pushParams] = [...branches.entries()][0]!;
    expect(pushParams.files.has("src/hello.ts")).toBe(true);
    const pushedContent = new TextDecoder().decode(pushParams.files.get("src/hello.ts"));
    expect(pushedContent).toBe("export const hello = 'world';");
  });
});

// ---------------------------------------------------------------------------
// Full round-trip: import → verify store state
// ---------------------------------------------------------------------------

describe("integration: import from PR", () => {
  test("full flow: PR → contribution in SQLite store", async () => {
    const client = new InMemoryGitHubClient();
    const repo = { owner: "bob", repo: "lib" };
    client.seedRepo(repo);

    const pr = makeTestPR({
      number: 44,
      title: "Fix memory leak in parser",
      body: "The parser was holding references too long",
      author: "bob",
      files: [
        makeTestPRFile({
          filename: "src/parser.ts",
          status: "modified",
          additions: 5,
          deletions: 10,
          patch: "@@ -42,10 +42,5 @@\n-old code\n+new code",
        }),
      ],
      comments: [makeTestComment({ body: "Great fix!", author: "reviewer" })],
      reviewComments: [
        makeTestReviewComment({
          body: "Consider using WeakRef here",
          path: "src/parser.ts",
          line: 45,
        }),
      ],
    });
    client.seedPR(repo, pr, "diff --git a/src/parser.ts b/src/parser.ts\n-old\n+new");

    const adapter = createGitHubAdapter({
      client,
      store: stores.contributionStore,
      cas,
      agent: testAgent,
    });

    const result = await adapter.importFromPR({ ...repo, number: 44 });

    // Verify contribution in store
    const fetched = await stores.contributionStore.get(result.contribution.cid);
    expect(fetched).toBeDefined();
    expect(fetched?.kind).toBe(ContributionKind.Work);
    expect(fetched?.summary).toContain("GitHub PR #44");
    expect(fetched?.summary).toContain("Fix memory leak");
    expect(fetched?.tags).toContain("github-import");

    // Verify diff artifact in CAS
    const diffHash = fetched?.artifacts.diff;
    expect(diffHash).toBeDefined();
    const diffData = await cas.get(diffHash!);
    expect(diffData).toBeDefined();
    expect(new TextDecoder().decode(diffData!)).toContain("diff --git");

    // Verify file patch artifact
    expect(fetched?.artifacts["patches/src/parser.ts"]).toBeDefined();

    // Verify GitHub metadata in context
    const gh = fetched?.context?.github as Record<string, unknown>;
    expect(gh.type).toBe("pull_request");
    expect(gh.author).toBe("bob");
    expect(gh.number).toBe(44);
    expect((gh.comments as Array<unknown>).length).toBe(1);
    expect((gh.reviewComments as Array<unknown>).length).toBe(1);
  });

  test("imported contribution is queryable by tags", async () => {
    const client = new InMemoryGitHubClient();
    const repo = { owner: "test", repo: "repo" };
    client.seedRepo(repo);
    client.seedPR(repo, makeTestPR({ number: 1 }));

    const adapter = createGitHubAdapter({
      client,
      store: stores.contributionStore,
      cas,
      agent: testAgent,
    });

    await adapter.importFromPR({ ...repo, number: 1 });

    const results = await stores.contributionStore.list({ tags: ["github-import"] });
    expect(results.length).toBe(1);
  });
});

describe("integration: import from Discussion", () => {
  test("full flow: Discussion → contribution in SQLite store", async () => {
    const client = new InMemoryGitHubClient();
    const repo = { owner: "carol", repo: "ideas" };
    client.seedRepo(repo);

    const disc = makeTestDiscussion({
      number: 43,
      title: "Proposal: New scoring algorithm",
      body: "We should consider a multi-objective approach",
      author: "carol",
      comments: [
        makeTestDiscussionComment({
          body: "I agree with the approach",
          isAnswer: true,
          replies: [makeTestComment({ body: "Thanks for the feedback" })],
        }),
      ],
    });
    client.seedDiscussion(repo, disc);

    const adapter = createGitHubAdapter({
      client,
      store: stores.contributionStore,
      cas,
      agent: testAgent,
    });

    const result = await adapter.importFromDiscussion({ ...repo, number: 43 });

    // Verify contribution in store
    const fetched = await stores.contributionStore.get(result.contribution.cid);
    expect(fetched).toBeDefined();
    expect(fetched?.kind).toBe(ContributionKind.Discussion);
    expect(fetched?.summary).toContain("GitHub Discussion #43");
    expect(fetched?.tags).toContain("discussion");

    // Verify GitHub metadata
    const gh = fetched?.context?.github as Record<string, unknown>;
    expect(gh.type).toBe("discussion");
    expect(gh.author).toBe("carol");
    const comments = gh.comments as Array<Record<string, unknown>>;
    expect(comments.length).toBe(1);
    expect(comments[0]?.isAnswer).toBe(true);
  });
});
