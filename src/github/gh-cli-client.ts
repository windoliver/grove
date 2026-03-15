/**
 * GitHubClient implementation using the gh CLI.
 *
 * Spawns `gh` commands via the shared subprocess utility.
 * Relies on ambient authentication (gh auth login).
 *
 * GraphQL is used for Discussions (REST API not available).
 * REST is used for PRs (simpler, well-supported).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnCommand, spawnOrThrow } from "../core/subprocess.js";
import type {
  CreateDiscussionParams,
  CreatePRParams,
  GitHubClient,
  PushBranchParams,
} from "./client.js";
import { classifyGhError, GhCliNotFoundError } from "./errors.js";
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
// In-memory TTL cache (reduces redundant GitHub API calls ~80-90%)
// ---------------------------------------------------------------------------

interface CacheEntry {
  readonly data: unknown;
  readonly cachedAt: number;
}

/** Simple time-based cache — avoids repeated API calls within a TTL window. */
const apiCache = new Map<string, CacheEntry>();

/** Cache TTL in milliseconds (60 seconds). */
const CACHE_TTL_MS = 60_000;

/** Return cached data if still fresh, or undefined. */
function getCached<T>(key: string): T | undefined {
  const entry = apiCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    apiCache.delete(key);
    return undefined;
  }
  return entry.data as T;
}

/** Store data in the cache. */
function setCached(key: string, data: unknown): void {
  apiCache.set(key, { data, cachedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a gh API REST call and parse JSON response. */
async function ghApiRest<T>(endpoint: string, args: readonly string[] = []): Promise<T> {
  const result = await spawnCommand(
    ["gh", "api", endpoint, "--header", "Accept: application/vnd.github+json", ...args],
    { timeoutMs: 30_000 },
  );

  if (result.exitCode !== 0) {
    throw classifyGhError(result.exitCode, result.stderr, endpoint);
  }

  return JSON.parse(result.stdout) as T;
}

/** Run a gh API GraphQL call and parse JSON response. */
async function ghApiGraphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const varArgs: string[] = [];
  for (const [key, value] of Object.entries(variables)) {
    if (typeof value === "string") {
      varArgs.push("-f", `${key}=${value}`);
    } else {
      varArgs.push("-F", `${key}=${JSON.stringify(value)}`);
    }
  }

  const result = await spawnCommand(["gh", "api", "graphql", "-f", `query=${query}`, ...varArgs], {
    timeoutMs: 30_000,
  });

  if (result.exitCode !== 0) {
    throw classifyGhError(result.exitCode, result.stderr, "graphql");
  }

  const parsed = JSON.parse(result.stdout) as { data?: T; errors?: Array<{ message: string }> };

  if (parsed.errors && parsed.errors.length > 0) {
    const messages = parsed.errors.map((e) => e.message).join("; ");
    throw classifyGhError(1, messages, "graphql");
  }

  if (!parsed.data) {
    throw classifyGhError(1, "No data in GraphQL response", "graphql");
  }

  return parsed.data;
}

/** Run a gh API REST call for paginated results. */
async function ghApiRestPaginated<T>(endpoint: string, _maxPages: number = 10): Promise<T[]> {
  const result = await spawnCommand(
    ["gh", "api", endpoint, "--paginate", "--header", "Accept: application/vnd.github+json"],
    { timeoutMs: 60_000 },
  );

  if (result.exitCode !== 0) {
    throw classifyGhError(result.exitCode, result.stderr, endpoint);
  }

  // gh --paginate concatenates JSON arrays or outputs multiple JSON objects
  // For array endpoints, it outputs valid JSON arrays that may be concatenated
  const stdout = result.stdout.trim();
  if (!stdout) return [];

  // gh --paginate for array endpoints outputs concatenated arrays like [...][\n...]
  // Try parsing as a single array first, then handle concatenated arrays
  try {
    return JSON.parse(stdout) as T[];
  } catch {
    // Handle concatenated arrays: ][  → ,
    const fixed = `[${stdout.replace(/\]\s*\[/g, ",")}]`;
    try {
      // The concatenated result may be a nested array, flatten one level
      const nested = JSON.parse(fixed) as T[][];
      return nested.flat() as T[];
    } catch {
      return JSON.parse(`[${stdout}]`) as T[];
    }
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a GhCliClient that uses the gh CLI for GitHub API access.
 *
 * Validates that gh is installed and authenticated before returning.
 */
export async function createGhCliClient(): Promise<GitHubClient> {
  // Verify gh CLI is available
  const versionResult = await spawnCommand(["gh", "--version"], { timeoutMs: 5_000 });
  if (versionResult.exitCode !== 0) {
    throw new GhCliNotFoundError();
  }

  // Verify authentication
  const authResult = await spawnCommand(["gh", "auth", "status"], { timeoutMs: 10_000 });
  if (authResult.exitCode !== 0) {
    throw new (await import("./errors.js")).GitHubAuthError();
  }

  return {
    getRepoId: async (repo: RepoRef): Promise<string> => {
      const data = await ghApiGraphql<{
        repository: { id: string };
      }>(
        `query($owner: String!, $repo: String!) {
          repository(owner: $owner, name: $repo) { id }
        }`,
        { owner: repo.owner, repo: repo.repo },
      );
      return data.repository.id;
    },

    getDiscussionCategories: async (repo: RepoRef): Promise<readonly DiscussionCategory[]> => {
      const data = await ghApiGraphql<{
        repository: {
          discussionCategories: {
            nodes: Array<{ id: string; name: string }>;
          };
        };
      }>(
        `query($owner: String!, $repo: String!) {
          repository(owner: $owner, name: $repo) {
            discussionCategories(first: 25) {
              nodes { id name }
            }
          }
        }`,
        { owner: repo.owner, repo: repo.repo },
      );
      return data.repository.discussionCategories.nodes;
    },

    getDefaultBranch: async (repo: RepoRef): Promise<string> => {
      const data = await ghApiRest<{ default_branch: string }>(`repos/${repo.owner}/${repo.repo}`);
      return data.default_branch;
    },

    createDiscussion: async (params: CreateDiscussionParams): Promise<CreateDiscussionResult> => {
      // Get repo ID and category ID
      const repoData = await ghApiGraphql<{
        repository: {
          id: string;
          discussionCategories: {
            nodes: Array<{ id: string; name: string }>;
          };
        };
      }>(
        `query($owner: String!, $repo: String!) {
          repository(owner: $owner, name: $repo) {
            id
            discussionCategories(first: 25) {
              nodes { id name }
            }
          }
        }`,
        { owner: params.repo.owner, repo: params.repo.repo },
      );

      const category = repoData.repository.discussionCategories.nodes.find(
        (c) => c.name.toLowerCase() === params.categoryName.toLowerCase(),
      );

      if (!category) {
        const available = repoData.repository.discussionCategories.nodes
          .map((c) => c.name)
          .join(", ");
        throw new (await import("./errors.js")).GitHubValidationError(
          `Discussion category '${params.categoryName}' not found. Available: ${available}`,
        );
      }

      const data = await ghApiGraphql<{
        createDiscussion: {
          discussion: { id: string; url: string; number: number };
        };
      }>(
        `mutation($repoId: ID!, $catId: ID!, $title: String!, $body: String!) {
          createDiscussion(input: {
            repositoryId: $repoId,
            categoryId: $catId,
            title: $title,
            body: $body
          }) {
            discussion { id url number }
          }
        }`,
        {
          repoId: repoData.repository.id,
          catId: category.id,
          title: params.title,
          body: params.body,
        },
      );

      return data.createDiscussion.discussion;
    },

    getDiscussion: async (ref: DiscussionRef): Promise<GitHubDiscussion> => {
      type CommentNode = {
        id: string;
        body: string;
        createdAt: string;
        isAnswer: boolean;
        author: { login: string } | null;
        replies: {
          nodes: Array<{
            id: string;
            body: string;
            createdAt: string;
            author: { login: string } | null;
          }>;
        };
      };

      type DiscussionResponse = {
        repository: {
          discussion: {
            number: number;
            title: string;
            body: string;
            url: string;
            createdAt: string;
            author: { login: string } | null;
            category: { name: string };
            comments: {
              nodes: CommentNode[];
              pageInfo: { hasNextPage: boolean; endCursor: string };
            };
          } | null;
        };
      };

      // Build the query with optional cursor for pagination
      const buildQuery = (withCursor: boolean) =>
        `query($owner: String!, $repo: String!, $number: Int!${withCursor ? ", $cursor: String!" : ""}) {
          repository(owner: $owner, name: $repo) {
            discussion(number: $number) {
              number title body url createdAt
              author { login }
              category { name }
              comments(first: 100${withCursor ? ", after: $cursor" : ""}) {
                nodes {
                  id body createdAt isAnswer
                  author { login }
                  replies(first: 100) {
                    nodes {
                      id body createdAt
                      author { login }
                    }
                  }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`;

      // First page
      const firstPage = await ghApiGraphql<DiscussionResponse>(buildQuery(false), {
        owner: ref.owner,
        repo: ref.repo,
        number: ref.number,
      });

      const disc = firstPage.repository.discussion;
      if (!disc) {
        throw new (await import("./errors.js")).GitHubNotFoundError(
          `Discussion #${ref.number} in ${ref.owner}/${ref.repo}`,
        );
      }

      // Collect all comment nodes, paginating if needed (max 10 pages to bound)
      const allNodes: CommentNode[] = [...disc.comments.nodes];
      let pageInfo = disc.comments.pageInfo;
      let pages = 1;
      const maxPages = 10;

      while (pageInfo.hasNextPage && pages < maxPages) {
        const nextPage = await ghApiGraphql<DiscussionResponse>(buildQuery(true), {
          owner: ref.owner,
          repo: ref.repo,
          number: ref.number,
          cursor: pageInfo.endCursor,
        });

        const nextDisc = nextPage.repository.discussion;
        if (!nextDisc) break;

        allNodes.push(...nextDisc.comments.nodes);
        pageInfo = nextDisc.comments.pageInfo;
        pages++;
      }

      const comments: DiscussionComment[] = allNodes.map((c) => ({
        id: c.id,
        body: c.body,
        author: c.author?.login ?? "unknown",
        createdAt: c.createdAt,
        isAnswer: c.isAnswer,
        replies: c.replies.nodes.map((r) => ({
          id: r.id,
          body: r.body,
          author: r.author?.login ?? "unknown",
          createdAt: r.createdAt,
        })),
      }));

      return {
        number: disc.number,
        title: disc.title,
        body: disc.body,
        url: disc.url,
        author: disc.author?.login ?? "unknown",
        categoryName: disc.category.name,
        createdAt: disc.createdAt,
        comments,
      };
    },

    createPR: async (params: CreatePRParams): Promise<CreatePRResult> => {
      const data = await ghApiRest<{ number: number; html_url: string }>(
        `repos/${params.repo.owner}/${params.repo.repo}/pulls`,
        [
          "--method",
          "POST",
          "--field",
          `title=${params.title}`,
          "--field",
          `body=${params.body}`,
          "--field",
          `head=${params.head}`,
          "--field",
          `base=${params.base}`,
        ],
      );

      return { number: data.number, url: data.html_url };
    },

    getPR: async (ref: PRRef): Promise<GitHubPR> => {
      const cacheKey = `pr:${ref.owner}/${ref.repo}#${ref.number}`;
      const cached = getCached<GitHubPR>(cacheKey);
      if (cached) return cached;

      // Fetch PR metadata
      const prData = await ghApiRest<{
        number: number;
        title: string;
        body: string | null;
        state: string;
        merged: boolean;
        html_url: string;
        created_at: string;
        user: { login: string } | null;
        base: { ref: string };
        head: { ref: string };
      }>(`repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`);

      // Fetch files (paginated)
      const filesData = await ghApiRestPaginated<{
        filename: string;
        status: string;
        additions: number;
        deletions: number;
        patch?: string;
      }>(`repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files`);

      // Fetch issue comments
      const commentsData = await ghApiRestPaginated<{
        id: number;
        body: string | null;
        created_at: string;
        user: { login: string } | null;
      }>(`repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`);

      // Fetch review comments
      const reviewCommentsData = await ghApiRestPaginated<{
        id: number;
        body: string;
        created_at: string;
        path: string;
        line: number | null;
        diff_hunk: string;
        user: { login: string } | null;
      }>(`repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`);

      const files: PRFile[] = filesData.map((f) => ({
        filename: f.filename,
        status: f.status as PRFile["status"],
        additions: f.additions,
        deletions: f.deletions,
        ...(f.patch !== undefined ? { patch: f.patch } : {}),
      }));

      const comments: GitHubComment[] = commentsData.map((c) => ({
        id: String(c.id),
        body: c.body ?? "",
        author: c.user?.login ?? "unknown",
        createdAt: c.created_at,
      }));

      const reviewComments: PRReviewComment[] = reviewCommentsData.map((c) => ({
        id: String(c.id),
        body: c.body,
        author: c.user?.login ?? "unknown",
        createdAt: c.created_at,
        path: c.path,
        ...(c.line !== null ? { line: c.line } : {}),
        diffHunk: c.diff_hunk,
      }));

      // GitHub REST API reports merged PRs as state:"closed" with merged:true.
      // Normalize to our "open" | "closed" | "merged" union.
      const state: GitHubPR["state"] = prData.merged
        ? "merged"
        : (prData.state as "open" | "closed");

      const result: GitHubPR = {
        number: prData.number,
        title: prData.title,
        body: prData.body ?? "",
        state,
        url: prData.html_url,
        author: prData.user?.login ?? "unknown",
        baseBranch: prData.base.ref,
        headBranch: prData.head.ref,
        createdAt: prData.created_at,
        files,
        comments,
        reviewComments,
      };

      setCached(cacheKey, result);
      return result;
    },

    getPRDiff: async (ref: PRRef): Promise<string> => {
      const result = await spawnCommand(
        [
          "gh",
          "api",
          `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
          "--header",
          "Accept: application/vnd.github.v3.diff",
        ],
        { timeoutMs: 60_000 },
      );

      if (result.exitCode !== 0) {
        throw classifyGhError(
          result.exitCode,
          result.stderr,
          `PR diff #${ref.number} in ${ref.owner}/${ref.repo}`,
        );
      }

      return result.stdout;
    },

    pushBranch: async (params: PushBranchParams): Promise<void> => {
      // Clone the repo to a temp directory, create branch, add files, push
      const tmpDir = await mkdtemp(join(tmpdir(), "grove-github-"));

      try {
        // Clone (shallow) the repo
        await spawnOrThrow(
          [
            "gh",
            "repo",
            "clone",
            `${params.repo.owner}/${params.repo.repo}`,
            tmpDir,
            "--",
            "--depth",
            "1",
            "--branch",
            params.baseBranch,
          ],
          { timeoutMs: 60_000 },
          "gh repo clone",
        );

        // Create and checkout new branch
        await spawnOrThrow(
          ["git", "checkout", "-b", params.branch],
          { cwd: tmpDir },
          "git checkout -b",
        );

        // Write files
        for (const [filePath, content] of params.files) {
          const fullPath = join(tmpDir, filePath);
          const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
          // Ensure parent dirs exist before writing
          await spawnCommand(["mkdir", "-p", dir]);
          await Bun.write(fullPath, content);
        }

        // Stage and commit
        const hasFiles = params.files.size > 0;
        if (hasFiles) {
          await spawnOrThrow(["git", "add", "."], { cwd: tmpDir }, "git add");
        }
        await spawnOrThrow(
          ["git", "commit", ...(hasFiles ? [] : ["--allow-empty"]), "-m", params.commitMessage],
          { cwd: tmpDir },
          "git commit",
        );

        // Push
        await spawnOrThrow(
          ["git", "push", "origin", params.branch],
          { cwd: tmpDir, timeoutMs: 60_000 },
          "git push",
        );
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  };
}
