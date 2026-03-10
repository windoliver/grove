/**
 * Light conformance test suite for GitHubClient interface.
 *
 * Validates that InMemoryGitHubClient (the test mock) behaves
 * correctly, ensuring tests that use it are realistic.
 *
 * Any future GitHubClient implementation (Octokit, etc.) should
 * also pass these tests.
 */

import { describe, expect, test } from "bun:test";
import { GitHubNotFoundError, GitHubValidationError } from "./errors.js";
import { InMemoryGitHubClient, makeTestDiscussion, makeTestPR } from "./testing.js";

function createSeededClient(): InMemoryGitHubClient {
  const client = new InMemoryGitHubClient();
  client.seedRepo(
    { owner: "test", repo: "repo" },
    {
      categories: [
        { id: "cat-1", name: "General" },
        { id: "cat-2", name: "Ideas" },
      ],
    },
  );
  return client;
}

describe("GitHubClient conformance", () => {
  // ---- Repository operations ----

  test("getRepoId returns a string for a seeded repo", async () => {
    const client = createSeededClient();
    const id = await client.getRepoId({ owner: "test", repo: "repo" });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  test("getRepoId throws GitHubNotFoundError for unknown repo", async () => {
    const client = new InMemoryGitHubClient();
    await expect(client.getRepoId({ owner: "no", repo: "such" })).rejects.toBeInstanceOf(
      GitHubNotFoundError,
    );
  });

  test("getDiscussionCategories returns seeded categories", async () => {
    const client = createSeededClient();
    const cats = await client.getDiscussionCategories({ owner: "test", repo: "repo" });
    expect(cats.length).toBe(2);
    expect(cats.map((c) => c.name)).toContain("General");
    expect(cats.map((c) => c.name)).toContain("Ideas");
  });

  test("getDefaultBranch returns default branch", async () => {
    const client = createSeededClient();
    const branch = await client.getDefaultBranch({ owner: "test", repo: "repo" });
    expect(branch).toBe("main");
  });

  // ---- Discussion operations ----

  test("createDiscussion returns result with url and number", async () => {
    const client = createSeededClient();
    const result = await client.createDiscussion({
      repo: { owner: "test", repo: "repo" },
      categoryName: "General",
      title: "Test",
      body: "Body",
    });
    expect(result.number).toBeGreaterThan(0);
    expect(result.url).toContain("discussions");
    expect(result.id.length).toBeGreaterThan(0);
  });

  test("createDiscussion throws for unknown category", async () => {
    const client = createSeededClient();
    await expect(
      client.createDiscussion({
        repo: { owner: "test", repo: "repo" },
        categoryName: "NonExistent",
        title: "Test",
        body: "Body",
      }),
    ).rejects.toBeInstanceOf(GitHubValidationError);
  });

  test("getDiscussion returns created discussion", async () => {
    const client = createSeededClient();
    const ref = { owner: "test", repo: "repo" };
    const created = await client.createDiscussion({
      repo: ref,
      categoryName: "General",
      title: "My Discussion",
      body: "My body",
    });

    const fetched = await client.getDiscussion({ ...ref, number: created.number });
    expect(fetched.title).toBe("My Discussion");
    expect(fetched.body).toBe("My body");
    expect(fetched.categoryName).toBe("General");
  });

  test("getDiscussion returns seeded discussion", async () => {
    const client = createSeededClient();
    const ref = { owner: "test", repo: "repo" };
    const disc = makeTestDiscussion({ number: 42, title: "Seeded" });
    client.seedDiscussion(ref, disc);

    const fetched = await client.getDiscussion({ ...ref, number: 42 });
    expect(fetched.title).toBe("Seeded");
  });

  test("getDiscussion throws for unknown number", async () => {
    const client = createSeededClient();
    await expect(
      client.getDiscussion({ owner: "test", repo: "repo", number: 999 }),
    ).rejects.toBeInstanceOf(GitHubNotFoundError);
  });

  // ---- PR operations ----

  test("createPR returns result with url and number", async () => {
    const client = createSeededClient();
    const result = await client.createPR({
      repo: { owner: "test", repo: "repo" },
      title: "Test PR",
      body: "Body",
      head: "feature",
      base: "main",
    });
    expect(result.number).toBeGreaterThan(0);
    expect(result.url).toContain("pull");
  });

  test("getPR returns seeded PR", async () => {
    const client = createSeededClient();
    const ref = { owner: "test", repo: "repo" };
    const pr = makeTestPR({ number: 10, title: "Seeded PR" });
    client.seedPR(ref, pr);

    const fetched = await client.getPR({ ...ref, number: 10 });
    expect(fetched.title).toBe("Seeded PR");
  });

  test("getPR throws for unknown number", async () => {
    const client = createSeededClient();
    await expect(client.getPR({ owner: "test", repo: "repo", number: 999 })).rejects.toBeInstanceOf(
      GitHubNotFoundError,
    );
  });

  test("getPRDiff returns seeded diff", async () => {
    const client = createSeededClient();
    const ref = { owner: "test", repo: "repo" };
    const pr = makeTestPR({ number: 5 });
    client.seedPR(ref, pr, "diff --git a/file.ts b/file.ts\n+hello");

    const diff = await client.getPRDiff({ ...ref, number: 5 });
    expect(diff).toContain("diff --git");
  });

  test("getPRDiff returns empty string when no diff seeded", async () => {
    const client = createSeededClient();
    const ref = { owner: "test", repo: "repo" };
    client.seedPR(ref, makeTestPR({ number: 6 }));

    const diff = await client.getPRDiff({ ...ref, number: 6 });
    expect(diff).toBe("");
  });

  // ---- Git operations ----

  test("pushBranch records the push", async () => {
    const client = createSeededClient();
    const ref = { owner: "test", repo: "repo" };
    const files = new Map<string, Uint8Array>();
    files.set("file.txt", new TextEncoder().encode("content"));

    await client.pushBranch({
      repo: ref,
      branch: "grove/test",
      baseBranch: "main",
      files,
      commitMessage: "test commit",
    });

    const branches = client.getPushedBranches(ref);
    expect(branches.has("grove/test")).toBe(true);
  });
});
