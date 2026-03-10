/**
 * GitHub domain types for the adapter layer.
 *
 * These types represent GitHub API responses in a normalized form.
 * They are independent of the transport mechanism (gh CLI, Octokit, etc.).
 */

/** A GitHub repository reference. */
export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

/** A GitHub PR reference (repo + PR number). */
export interface PRRef extends RepoRef {
  readonly number: number;
}

/** A GitHub Discussion reference (repo + Discussion number). */
export interface DiscussionRef extends RepoRef {
  readonly number: number;
}

/** A file changed in a PR. */
export interface PRFile {
  readonly filename: string;
  readonly status:
    | "added"
    | "removed"
    | "modified"
    | "renamed"
    | "copied"
    | "changed"
    | "unchanged";
  readonly additions: number;
  readonly deletions: number;
  readonly patch?: string;
}

/** A comment on a PR or Discussion. */
export interface GitHubComment {
  readonly id: string;
  readonly body: string;
  readonly author: string;
  readonly createdAt: string;
}

/** A PR review comment (inline on a diff). */
export interface PRReviewComment extends GitHubComment {
  readonly path: string;
  readonly line?: number;
  readonly diffHunk?: string;
}

/** A GitHub Pull Request. */
export interface GitHubPR {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed" | "merged";
  readonly url: string;
  readonly author: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly createdAt: string;
  readonly files: readonly PRFile[];
  readonly comments: readonly GitHubComment[];
  readonly reviewComments: readonly PRReviewComment[];
}

/** A Discussion comment with optional nested replies. */
export interface DiscussionComment extends GitHubComment {
  readonly isAnswer: boolean;
  readonly replies: readonly GitHubComment[];
}

/** A GitHub Discussion. */
export interface GitHubDiscussion {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly author: string;
  readonly categoryName: string;
  readonly createdAt: string;
  readonly comments: readonly DiscussionComment[];
}

/** Result of creating a Discussion on GitHub. */
export interface CreateDiscussionResult {
  readonly id: string;
  readonly url: string;
  readonly number: number;
}

/** Result of creating a PR on GitHub. */
export interface CreatePRResult {
  readonly number: number;
  readonly url: string;
}

/** Discussion category metadata. */
export interface DiscussionCategory {
  readonly id: string;
  readonly name: string;
}
