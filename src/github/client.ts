/**
 * GitHubClient interface — the port abstraction for GitHub API operations.
 *
 * Implementations include GhCliClient (production, uses gh CLI) and
 * InMemoryGitHubClient (testing). This follows the same protocol-first
 * pattern used by ContributionStore and ClaimStore.
 */

import type {
  CreateDiscussionResult,
  CreatePRResult,
  DiscussionCategory,
  DiscussionRef,
  GitHubDiscussion,
  GitHubPR,
  PRRef,
  RepoRef,
} from "./types.js";

/** Parameters for creating a Discussion. */
export interface CreateDiscussionParams {
  readonly repo: RepoRef;
  readonly categoryName: string;
  readonly title: string;
  readonly body: string;
}

/** Parameters for creating a PR. */
export interface CreatePRParams {
  readonly repo: RepoRef;
  readonly title: string;
  readonly body: string;
  readonly head: string;
  readonly base: string;
}

/** Parameters for creating a git branch and pushing files. */
export interface PushBranchParams {
  readonly repo: RepoRef;
  readonly branch: string;
  readonly baseBranch: string;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly commitMessage: string;
}

/**
 * Abstract interface for GitHub API operations.
 *
 * All methods return immutable result types. Implementations handle
 * pagination, rate limiting, and error classification internally.
 */
export interface GitHubClient {
  // ---- Repository ----

  /** Get the GraphQL node ID for a repository. */
  readonly getRepoId: (repo: RepoRef) => Promise<string>;

  /** List Discussion categories for a repository. */
  readonly getDiscussionCategories: (repo: RepoRef) => Promise<readonly DiscussionCategory[]>;

  /** Get the default branch name for a repository. */
  readonly getDefaultBranch: (repo: RepoRef) => Promise<string>;

  // ---- Discussions ----

  /** Create a new Discussion. */
  readonly createDiscussion: (params: CreateDiscussionParams) => Promise<CreateDiscussionResult>;

  /** Get a Discussion by number, including comments. */
  readonly getDiscussion: (ref: DiscussionRef) => Promise<GitHubDiscussion>;

  // ---- Pull Requests ----

  /** Create a new PR. */
  readonly createPR: (params: CreatePRParams) => Promise<CreatePRResult>;

  /** Get a PR by number, including files and comments. */
  readonly getPR: (ref: PRRef) => Promise<GitHubPR>;

  /** Get the raw diff for a PR. */
  readonly getPRDiff: (ref: PRRef) => Promise<string>;

  // ---- Git operations ----

  /** Create a branch, commit files, and push to remote. */
  readonly pushBranch: (params: PushBranchParams) => Promise<void>;
}
