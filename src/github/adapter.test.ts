/**
 * Unit tests for the GitHub adapter.
 *
 * Uses InMemoryGitHubClient and InMemoryContributionStore for fast,
 * deterministic tests without I/O.
 */

import { describe, expect, test } from "bun:test";
import { createContribution } from "../core/manifest.js";
import type { Contribution, ContributionInput } from "../core/models.js";
import { ContributionKind, ContributionMode } from "../core/models.js";
import { InMemoryContributionStore } from "../core/testing.js";
import { createGitHubAdapter } from "./adapter.js";
import type { PushBranchParams } from "./client.js";
import { GitHubNotFoundError, GitHubValidationError } from "./errors.js";
import {
  InMemoryGitHubClient,
  makeTestComment,
  makeTestDiscussion,
  makeTestDiscussionComment,
  makeTestPR,
  makeTestPRFile,
} from "./testing.js";

// ---------------------------------------------------------------------------
// In-memory CAS for tests
// ---------------------------------------------------------------------------

class InMemoryCas {
  private readonly blobs = new Map<string, Uint8Array>();
  private counter = 0;

  put = async (data: Uint8Array, _options?: { mediaType?: string }): Promise<string> => {
    const hash = `blake3:${"0".repeat(52)}${String(this.counter++).padStart(12, "0")}`;
    this.blobs.set(hash, data);
    return hash;
  };

  get = async (hash: string): Promise<Uint8Array | undefined> => {
    return this.blobs.get(hash);
  };

  exists = async (hash: string): Promise<boolean> => {
    return this.blobs.has(hash);
  };

  existsMany = async (hashes: readonly string[]): Promise<ReadonlyMap<string, boolean>> => {
    const result = new Map<string, boolean>();
    for (const hash of hashes) {
      result.set(hash, this.blobs.has(hash));
    }
    return result;
  };

  delete = async (hash: string): Promise<boolean> => {
    return this.blobs.delete(hash);
  };

  putFile = async (): Promise<string> => {
    throw new Error("Not implemented in test CAS");
  };

  getToFile = async (): Promise<boolean> => {
    throw new Error("Not implemented in test CAS");
  };

  stat = async () => undefined;
  close = () => {};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testAgent = { agentId: "test-agent", agentName: "test" };

function makeContribution(overrides?: Partial<ContributionInput>): Contribution {
  return createContribution({
    kind: ContributionKind.Work,
    mode: ContributionMode.Evaluation,
    summary: "Test contribution",
    artifacts: {},
    relations: [],
    tags: [],
    agent: testAgent,
    createdAt: "2025-01-01T00:00:00Z",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Export to Discussion
// ---------------------------------------------------------------------------

describe("exportToDiscussion", () => {
  test("creates a Discussion from a contribution", async () => {
    const store = new InMemoryContributionStore();
    const cas = new InMemoryCas();
    const client = new InMemoryGitHubClient();
    const repo = { owner: "test", repo: "repo" };
    client.seedRepo(repo);

    const contribution = makeContribution({ summary: "My finding" });
    await store.put(contribution);

    const adapter = createGitHubAdapter({ client, store, cas, agent: testAgent });
    const result = await adapter.exportToDiscussion(repo, contribution.cid);

    expect(result.url).toContain("discussions");
    expect(result.discussionNumber).toBeGreaterThan(0);

    // Verify the discussion was created with correct content
    const disc = await client.getDiscussion({
      ...repo,
      number: result.discussionNumber,
    });
    expect(disc.title).toContain("My finding");
    expect(disc.body).toContain("My finding");
    expect(disc.body).toContain(contribution.cid);
  });

  test("uses specified category", async () => {
    const store = new InMemoryContributionStore();
    const cas = new InMemoryCas();
    const client = new InMemoryGitHubClient();
    const repo = { owner: "test", repo: "repo" };
    client.seedRepo(repo, {
      categories: [
        { id: "c1", name: "General" },
        { id: "c2", name: "Research" },
      ],
    });

    const contribution = makeContribution();
    await store.put(contribution);

    const adapter = createGitHubAdapter({ client, store, cas, agent: testAgent });
    const result = await adapter.exportToDiscussion(repo, contribution.cid, "Research");

    const disc = await client.getDiscussion({
      ...repo,
      number: result.discussionNumber,
    });
    expect(disc.categoryName).toBe("Research");
  });

  test("throws when contribution not found", async () => {
    const store = new InMemoryContributionStore();
    const cas = new InMemoryCas();
    const client = new InMemoryGitHubClient();
    client.seedRepo({ owner: "test", repo: "repo" });

    const adapter = createGitHubAdapter({ client, store, cas, agent: testAgent });
    await expect(
      adapter.exportToDiscussion({ owner: "test", repo: "repo" }, "blake3:nonexistent"),
    ).rejects.toThrow(/not found/i);
  });

  test("throws when category not found", async () => {
    const store = new InMemoryContributionStore();
    const cas = new InMemoryCas();
    const client = new InMemoryGitHubClient();
    const repo = { owner: "test", repo: "repo" };
    client.seedRepo(repo);

    const contribution = makeContribution();
    await store.put(contribution);

    const adapter = createGitHubAdapter({ client, store, cas, agent: testAgent });
    await expect(
      adapter.exportToDiscussion(repo, contribution.cid, "NonExistent"),
    ).rejects.toBeInstanceOf(GitHubValidationError);
  });

  test("throws when repo not found", async () => {
    const store = new InMemoryContributionStore();
    const cas = new InMemoryCas();
    const client = new InMemoryGitHubClient();

    const contribution = makeContribution();
    await store.put(contribution);

    const adapter = createGitHubAdapter({ client, store, cas, agent: testAgent });
    await expect(
      adapter.exportToDiscussion({ owner: "no", repo: "such" }, contribution.cid),
    ).rejects.toBeInstanceOf(GitHubNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Export to PR
// ---------------------------------------------------------------------------

describe("exportToPR", () => {
  test("creates a PR from a contribution with artifacts", async () => {
    const store = new InMemoryContributionStore();
    const cas = new InMemoryCas();
    const client = new InMemoryGitHubClient();
    const repo = { owner: "test", repo: "repo" };
    client.seedRepo(repo);

    // Store an artifact in CAS
    const fileContent = new TextEncoder().encode("console.log('hello');");
    const hash = await cas.put(fileContent);

    const contribution = makeContribution({
      summary: "Add feature",
      artifacts: { "src/index.ts": hash },
    });
    await store.put(contribution);

    const adapter = createGitHubAdapter({ client, store, cas, agent: testAgent });
    const result = await adapter.exportToPR(repo, contribution.cid);

    expect(result.url).toContain("pull");
    expect(result.prNumber).toBeGreaterThan(0);

    // Verify branch was pushed with correct files
    const branches = client.getPushedBranches(repo);
    expect(branches.size).toBe(1);
    // Size asserted above guarantees at least one entry
    const [branchName, pushParams] = [...branches.entries()][0] as [string, PushBranchParams];
    expect(branchName).toContain("grove/work/");
    expect(pushParams.files.has("src/index.ts")).toBe(true);
  });

  test("creates a PR from contribution with no artifacts", async () => {
    const store = new InMemoryContributionStore();
    const cas = new InMemoryCas();
    const client = new InMemoryGitHubClient();
    const repo = { owner: "test", repo: "repo" };
    client.seedRepo(repo);

    const contribution = makeContribution({ summary: "Empty contribution" });
    await store.put(contribution);

    const adapter = createGitHubAdapter({ client, store, cas, agent: testAgent });
    const result = await adapter.exportToPR(repo, contribution.cid);

    expect(result.prNumber).toBeGreaterThan(0);
  });

  test("throws when artifact missing from CAS", async () => {
    const store = new InMemoryContributionStore();
    const cas = new InMemoryCas();
    const client = new InMemoryGitHubClient();
    const repo = { owner: "test", repo: "repo" };
    client.seedRepo(repo);

    // Create contribution referencing an artifact hash that doesn't exist in CAS
    const contribution = makeContribution({
      artifacts: { "src/index.ts": "blake3:does_not_exist_in_cas" },
    });
    await store.put(contribution);

    const adapter = createGitHubAdapter({ client, store, cas, agent: testAgent });
    await expect(adapter.exportToPR(repo, contribution.cid)).rejects.toThrow(/not found in CAS/);
  });

  test("throws when contribution not found", async () => {
    const store = new InMemoryContributionStore();
    const cas = new InMemoryCas();
    const client = new InMemoryGitHubClient();
    client.seedRepo({ owner: "test", repo: "repo" });

    const adapter = createGitHubAdapter({ client, store, cas, agent: testAgent });
    await expect(
      adapter.exportToPR({ owner: "test", repo: "repo" }, "blake3:nonexistent"),
    ).rejects.toThrow(/not found/i);
  });

  test("throws when repo not found", async () => {
    const store = new InMemoryContributionStore();
    const cas = new InMemoryCas();
    const client = new InMemoryGitHubClient();

    const contribution = makeContribution();
    await store.put(contribution);

    const adapter = createGitHubAdapter({ client, store, cas, agent: testAgent });
    await expect(
      adapter.exportToPR({ owner: "no", repo: "such" }, contribution.cid),
    ).rejects.toBeInstanceOf(GitHubNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Import from PR
// ---------------------------------------------------------------------------

describe("importFromPR", () => {
  test("imports a PR as a work contribution", async () => {
    const store = new InMemoryContributionStore();
    const cas = new InMemoryCas();
    const client = new InMemoryGitHubClient();
    const repo = { owner: "test", repo: "repo" };
    client.seedRepo(repo);

    const pr = makeTestPR({
      number: 44,
      title: "Fix critical bug",
      body: "This fixes the thing",
      files: [makeTestPRFile({ filename: "src/fix.ts", patch: "+fixed" })],
      comments: [makeTestComment({ body: "LGTM" })],
    });
    client.seedPR(repo, pr, "diff --git a/src/fix.ts b/src/fix.ts\n+fixed");

    const adapter = createGitHubAdapter({ client, store, cas, agent: testAgent });
    const result = await adapter.importFromPR({ ...repo, number: 44 });

    expect(result.contribution.kind).toBe(ContributionKind.Work);
    expect(result.contribution.summary).toContain("GitHub PR #44");
    expect(result.contribution.summary).toContain("Fix critical bug");
    expect(result.contribution.description).toBe("This fixes the thing");

    // Verify diff was stored as artifact
    const diffHash = result.contribution.artifacts.diff;
    expect(diffHash).toBeDefined();
    const diffData = await cas.get(diffHash as string);
    expect(diffData).toBeDefined();
    expect(new TextDecoder().decode(diffData as Uint8Array)).toContain("diff --git");

    // Verify file patches stored (use array to avoid dot-splitting in key)
    expect(result.contribution.artifacts["patches/src/fix.ts"]).toBeDefined();

    // Verify stored in contribution store
    const fetched = await store.get(result.contribution.cid);
    expect(fetched).toBeDefined();
    expect(fetched?.cid).toBe(result.contribution.cid);
  });

  test("handles PR with empty diff", async () => {
    const store = new InMemoryContributionStore();
    const cas = new InMemoryCas();
    const client = new InMemoryGitHubClient();
    const repo = { owner: "test", repo: "repo" };
    client.seedRepo(repo);
    client.seedPR(repo, makeTestPR({ number: 1 }));

    const adapter = createGitHubAdapter({ client, store, cas, agent: testAgent });
    const result = await adapter.importFromPR({ ...repo, number: 1 });

    // No diff artifact when diff is empty
    expect(result.contribution.artifacts).not.toHaveProperty("diff");
  });

  test("preserves PR metadata in context", async () => {
    const store = new InMemoryContributionStore();
    const cas = new InMemoryCas();
    const client = new InMemoryGitHubClient();
    const repo = { owner: "alice", repo: "project" };
    client.seedRepo(repo);
    client.seedPR(
      repo,
      makeTestPR({
        number: 10,
        author: "alice",
        state: "open",
        baseBranch: "main",
        headBranch: "fix/issue-5",
      }),
    );

    const adapter = createGitHubAdapter({ client, store, cas, agent: testAgent });
    const result = await adapter.importFromPR({ ...repo, number: 10 });

    const gh = result.contribution.context?.github as Record<string, unknown>;
    expect(gh.type).toBe("pull_request");
    expect(gh.repo).toBe("alice/project");
    expect(gh.author).toBe("alice");
  });

  test("throws when PR not found", async () => {
    const store = new InMemoryContributionStore();
    const cas = new InMemoryCas();
    const client = new InMemoryGitHubClient();
    client.seedRepo({ owner: "test", repo: "repo" });

    const adapter = createGitHubAdapter({ client, store, cas, agent: testAgent });
    await expect(
      adapter.importFromPR({ owner: "test", repo: "repo", number: 999 }),
    ).rejects.toBeInstanceOf(GitHubNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Import from Discussion
// ---------------------------------------------------------------------------

describe("importFromDiscussion", () => {
  test("imports a Discussion as a discussion contribution", async () => {
    const store = new InMemoryContributionStore();
    const cas = new InMemoryCas();
    const client = new InMemoryGitHubClient();
    const repo = { owner: "test", repo: "repo" };
    client.seedRepo(repo);

    const disc = makeTestDiscussion({
      number: 43,
      title: "RFC: New algorithm",
      body: "Proposal details here",
      comments: [
        makeTestDiscussionComment({
          body: "Interesting approach",
          replies: [makeTestComment({ body: "Agreed" })],
        }),
      ],
    });
    client.seedDiscussion(repo, disc);

    const adapter = createGitHubAdapter({ client, store, cas, agent: testAgent });
    const result = await adapter.importFromDiscussion({ ...repo, number: 43 });

    expect(result.contribution.kind).toBe(ContributionKind.Discussion);
    expect(result.contribution.summary).toContain("GitHub Discussion #43");
    expect(result.contribution.summary).toContain("RFC: New algorithm");
    expect(result.contribution.description).toBe("Proposal details here");

    // Verify stored in contribution store
    const fetched = await store.get(result.contribution.cid);
    expect(fetched).toBeDefined();
  });

  test("handles Discussion with no comments", async () => {
    const store = new InMemoryContributionStore();
    const cas = new InMemoryCas();
    const client = new InMemoryGitHubClient();
    const repo = { owner: "test", repo: "repo" };
    client.seedRepo(repo);
    client.seedDiscussion(repo, makeTestDiscussion({ number: 1 }));

    const adapter = createGitHubAdapter({ client, store, cas, agent: testAgent });
    const result = await adapter.importFromDiscussion({ ...repo, number: 1 });
    expect(result.contribution).toBeDefined();
  });

  test("throws when Discussion not found", async () => {
    const store = new InMemoryContributionStore();
    const cas = new InMemoryCas();
    const client = new InMemoryGitHubClient();
    client.seedRepo({ owner: "test", repo: "repo" });

    const adapter = createGitHubAdapter({ client, store, cas, agent: testAgent });
    await expect(
      adapter.importFromDiscussion({ owner: "test", repo: "repo", number: 999 }),
    ).rejects.toBeInstanceOf(GitHubNotFoundError);
  });

  test("preserves discussion metadata in context", async () => {
    const store = new InMemoryContributionStore();
    const cas = new InMemoryCas();
    const client = new InMemoryGitHubClient();
    const repo = { owner: "alice", repo: "project" };
    client.seedRepo(repo);
    client.seedDiscussion(
      repo,
      makeTestDiscussion({
        number: 7,
        author: "bob",
        categoryName: "Ideas",
      }),
    );

    const adapter = createGitHubAdapter({ client, store, cas, agent: testAgent });
    const result = await adapter.importFromDiscussion({ ...repo, number: 7 });

    const gh = result.contribution.context?.github as Record<string, unknown>;
    expect(gh.type).toBe("discussion");
    expect(gh.repo).toBe("alice/project");
    expect(gh.author).toBe("bob");
    expect(gh.categoryName).toBe("Ideas");
  });
});
