/**
 * Test utilities for the GitHub adapter.
 *
 * Provides InMemoryGitHubClient and factory functions for test data.
 * Follows the same pattern as src/core/testing.ts (InMemoryContributionStore).
 */

import type {
  CreateDiscussionParams,
  CreatePRParams,
  GitHubClient,
  PushBranchParams,
} from "./client.js";
import { GitHubNotFoundError, GitHubValidationError } from "./errors.js";
import type {
  CreateDiscussionResult,
  CreatePRResult,
  DiscussionCategory,
  DiscussionComment,
  DiscussionRef,
  GitHubComment,
  GitHubDiscussion,
  GitHubPR,
  PRFile,
  PRRef,
  PRReviewComment,
  RepoRef,
} from "./types.js";

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/** Create a test PR with sensible defaults. Override any field. */
export function makeTestPR(overrides?: Partial<GitHubPR>): GitHubPR {
  return {
    number: 1,
    title: "Test PR",
    body: "Test PR body",
    state: "open",
    url: "https://github.com/test-owner/test-repo/pull/1",
    author: "test-user",
    baseBranch: "main",
    headBranch: "feature-branch",
    createdAt: "2025-01-01T00:00:00Z",
    files: [],
    comments: [],
    reviewComments: [],
    ...overrides,
  };
}

/** Create a test PR file with sensible defaults. */
export function makeTestPRFile(overrides?: Partial<PRFile>): PRFile {
  return {
    filename: "src/index.ts",
    status: "modified",
    additions: 10,
    deletions: 5,
    ...overrides,
  };
}

/** Create a test GitHub comment with sensible defaults. */
export function makeTestComment(overrides?: Partial<GitHubComment>): GitHubComment {
  return {
    id: "comment-1",
    body: "Test comment",
    author: "test-user",
    createdAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

/** Create a test PR review comment with sensible defaults. */
export function makeTestReviewComment(overrides?: Partial<PRReviewComment>): PRReviewComment {
  return {
    id: "review-comment-1",
    body: "Review comment",
    author: "reviewer",
    createdAt: "2025-01-01T00:00:00Z",
    path: "src/index.ts",
    line: 42,
    diffHunk: "@@ -40,6 +40,10 @@",
    ...overrides,
  };
}

/** Create a test Discussion with sensible defaults. */
export function makeTestDiscussion(overrides?: Partial<GitHubDiscussion>): GitHubDiscussion {
  return {
    number: 1,
    title: "Test Discussion",
    body: "Test Discussion body",
    url: "https://github.com/test-owner/test-repo/discussions/1",
    author: "test-user",
    categoryName: "General",
    createdAt: "2025-01-01T00:00:00Z",
    comments: [],
    ...overrides,
  };
}

/** Create a test Discussion comment with sensible defaults. */
export function makeTestDiscussionComment(
  overrides?: Partial<DiscussionComment>,
): DiscussionComment {
  return {
    id: "dc-1",
    body: "Discussion comment",
    author: "test-user",
    createdAt: "2025-01-01T00:00:00Z",
    isAnswer: false,
    replies: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

/** Repo key for internal maps. */
function repoKey(ref: RepoRef): string {
  return `${ref.owner}/${ref.repo}`;
}

/** Repo data held in memory. */
interface RepoData {
  readonly id: string;
  readonly defaultBranch: string;
  readonly categories: DiscussionCategory[];
  readonly prs: Map<number, GitHubPR>;
  readonly prDiffs: Map<number, string>;
  readonly discussions: Map<number, GitHubDiscussion>;
  nextNumber: number;
  readonly pushedBranches: Map<string, PushBranchParams>;
}

function createRepoData(
  repoId: string,
  defaultBranch: string = "main",
  categories: DiscussionCategory[] = [{ id: "cat-general", name: "General" }],
): RepoData {
  return {
    id: repoId,
    defaultBranch,
    categories,
    prs: new Map(),
    prDiffs: new Map(),
    discussions: new Map(),
    nextNumber: 1,
    pushedBranches: new Map(),
  };
}

/**
 * In-memory GitHubClient for testing.
 *
 * Pre-seed repos, PRs, and Discussions, then test adapter behavior
 * without network calls.
 */
export class InMemoryGitHubClient implements GitHubClient {
  private readonly repos = new Map<string, RepoData>();

  // ---- Seeding helpers ----

  /** Register a repo so API calls for it succeed. */
  seedRepo(
    ref: RepoRef,
    options?: {
      readonly repoId?: string;
      readonly defaultBranch?: string;
      readonly categories?: DiscussionCategory[];
    },
  ): void {
    const key = repoKey(ref);
    this.repos.set(
      key,
      createRepoData(
        options?.repoId ?? `R_${key}`,
        options?.defaultBranch ?? "main",
        options?.categories ?? [{ id: "cat-general", name: "General" }],
      ),
    );
  }

  /** Seed a PR in a repo. The repo must be seeded first. */
  seedPR(ref: RepoRef, pr: GitHubPR, diff?: string): void {
    const repo = this.getRepo(ref);
    repo.prs.set(pr.number, pr);
    if (diff !== undefined) {
      repo.prDiffs.set(pr.number, diff);
    }
    if (pr.number >= repo.nextNumber) {
      repo.nextNumber = pr.number + 1;
    }
  }

  /** Seed a Discussion in a repo. The repo must be seeded first. */
  seedDiscussion(ref: RepoRef, discussion: GitHubDiscussion): void {
    const repo = this.getRepo(ref);
    repo.discussions.set(discussion.number, discussion);
    if (discussion.number >= repo.nextNumber) {
      repo.nextNumber = discussion.number + 1;
    }
  }

  /** Get all pushed branches for inspection in tests. */
  getPushedBranches(ref: RepoRef): ReadonlyMap<string, PushBranchParams> {
    return this.getRepo(ref).pushedBranches;
  }

  // ---- GitHubClient implementation ----

  getRepoId = async (repo: RepoRef): Promise<string> => {
    return this.getRepo(repo).id;
  };

  getDiscussionCategories = async (repo: RepoRef): Promise<readonly DiscussionCategory[]> => {
    return this.getRepo(repo).categories;
  };

  getDefaultBranch = async (repo: RepoRef): Promise<string> => {
    return this.getRepo(repo).defaultBranch;
  };

  createDiscussion = async (params: CreateDiscussionParams): Promise<CreateDiscussionResult> => {
    const repo = this.getRepo(params.repo);

    const category = repo.categories.find(
      (c) => c.name.toLowerCase() === params.categoryName.toLowerCase(),
    );
    if (!category) {
      const available = repo.categories.map((c) => c.name).join(", ");
      throw new GitHubValidationError(
        `Discussion category '${params.categoryName}' not found. Available: ${available}`,
      );
    }

    const number = repo.nextNumber++;
    const id = `D_${number}`;
    const url = `https://github.com/${repoKey(params.repo)}/discussions/${number}`;

    const discussion: GitHubDiscussion = {
      number,
      title: params.title,
      body: params.body,
      url,
      author: "grove-bot",
      categoryName: params.categoryName,
      createdAt: new Date().toISOString(),
      comments: [],
    };
    repo.discussions.set(number, discussion);

    return { id, url, number };
  };

  getDiscussion = async (ref: DiscussionRef): Promise<GitHubDiscussion> => {
    const repo = this.getRepo(ref);
    const discussion = repo.discussions.get(ref.number);
    if (!discussion) {
      throw new GitHubNotFoundError(`Discussion #${ref.number} in ${ref.owner}/${ref.repo}`);
    }
    return discussion;
  };

  createPR = async (params: CreatePRParams): Promise<CreatePRResult> => {
    const repo = this.getRepo(params.repo);
    const number = repo.nextNumber++;
    const url = `https://github.com/${repoKey(params.repo)}/pull/${number}`;

    const pr: GitHubPR = {
      number,
      title: params.title,
      body: params.body,
      state: "open",
      url,
      author: "grove-bot",
      baseBranch: params.base,
      headBranch: params.head,
      createdAt: new Date().toISOString(),
      files: [],
      comments: [],
      reviewComments: [],
    };
    repo.prs.set(number, pr);

    return { number, url };
  };

  getPR = async (ref: PRRef): Promise<GitHubPR> => {
    const repo = this.getRepo(ref);
    const pr = repo.prs.get(ref.number);
    if (!pr) {
      throw new GitHubNotFoundError(`PR #${ref.number} in ${ref.owner}/${ref.repo}`);
    }
    return pr;
  };

  getPRDiff = async (ref: PRRef): Promise<string> => {
    const repo = this.getRepo(ref);
    if (!repo.prs.has(ref.number)) {
      throw new GitHubNotFoundError(`PR #${ref.number} in ${ref.owner}/${ref.repo}`);
    }
    return repo.prDiffs.get(ref.number) ?? "";
  };

  pushBranch = async (params: PushBranchParams): Promise<void> => {
    const repo = this.getRepo(params.repo);
    repo.pushedBranches.set(params.branch, params);
  };

  // ---- Internal helpers ----

  private getRepo(ref: RepoRef): RepoData {
    const key = repoKey(ref);
    const repo = this.repos.get(key);
    if (!repo) {
      throw new GitHubNotFoundError(`${ref.owner}/${ref.repo}`);
    }
    return repo;
  }
}
