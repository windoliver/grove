/**
 * GitHub adapter — orchestrates import/export between Grove and GitHub.
 *
 * Coordinates GitHubClient (API calls), mapper (transformations),
 * ContributionStore (persistence), and ContentStore (artifacts).
 *
 * This is the main entry point for grove export / grove import commands.
 */

import type { ContentStore } from "../core/cas.js";
import { createContribution } from "../core/manifest.js";
import type { AgentIdentity, Contribution } from "../core/models.js";
import type { ContributionStore } from "../core/store.js";
import type { GitHubClient } from "./client.js";
import {
  contributionToDiscussionBody,
  contributionToPRBody,
  discussionToContributionInput,
  prToContributionInput,
} from "./mapper.js";
import type { DiscussionRef, PRRef, RepoRef } from "./types.js";

// ---------------------------------------------------------------------------
// Export results
// ---------------------------------------------------------------------------

/** Result of exporting a contribution to a GitHub Discussion. */
export interface ExportToDiscussionResult {
  readonly url: string;
  readonly discussionNumber: number;
}

/** Result of exporting a contribution to a GitHub PR. */
export interface ExportToPRResult {
  readonly url: string;
  readonly prNumber: number;
}

/** Result of importing from GitHub. */
export interface ImportResult {
  readonly contribution: Contribution;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Options for creating a GitHubAdapter. */
export interface GitHubAdapterOptions {
  readonly client: GitHubClient;
  readonly store: ContributionStore;
  readonly cas: ContentStore;
  /** Agent identity used for imported contributions. */
  readonly agent: AgentIdentity;
}

/**
 * Create a GitHubAdapter for import/export operations.
 *
 * All methods are stateless — they read from the store and call the
 * GitHubClient as needed. The adapter does not maintain internal state.
 */
export function createGitHubAdapter(options: GitHubAdapterOptions) {
  const { client, store, cas, agent } = options;

  return {
    /**
     * Export a contribution to a GitHub Discussion.
     *
     * Creates a Discussion in the specified repo with the contribution's
     * summary, description, scores, and provenance information.
     *
     * @param repo - Target repository.
     * @param cid - CID of the contribution to export.
     * @param categoryName - Discussion category (e.g., "General"). Defaults to "General".
     */
    exportToDiscussion: async (
      repo: RepoRef,
      cid: string,
      categoryName: string = "General",
    ): Promise<ExportToDiscussionResult> => {
      const contribution = await store.get(cid);
      if (!contribution) {
        throw new Error(`Contribution not found: ${cid}`);
      }

      const { title, body } = contributionToDiscussionBody(contribution);

      const result = await client.createDiscussion({
        repo,
        categoryName,
        title,
        body,
      });

      return {
        url: result.url,
        discussionNumber: result.number,
      };
    },

    /**
     * Export a contribution to a GitHub PR.
     *
     * Creates a branch with the contribution's artifacts, commits them,
     * and opens a PR with the contribution summary as the body.
     *
     * @param repo - Target repository.
     * @param cid - CID of the contribution to export.
     */
    exportToPR: async (repo: RepoRef, cid: string): Promise<ExportToPRResult> => {
      const contribution = await store.get(cid);
      if (!contribution) {
        throw new Error(`Contribution not found: ${cid}`);
      }

      const { title, body, branchName } = contributionToPRBody(contribution);

      // Collect artifact contents from CAS — fail if any are missing
      const files = new Map<string, Uint8Array>();
      for (const [name, hash] of Object.entries(contribution.artifacts)) {
        const data = await cas.get(hash);
        if (!data) {
          throw new Error(
            `Artifact '${name}' with hash '${hash}' not found in CAS. Cannot export incomplete contribution.`,
          );
        }
        files.set(name, data);
      }

      // Get default branch for base
      const baseBranch = await client.getDefaultBranch(repo);

      // Push branch with artifacts
      await client.pushBranch({
        repo,
        branch: branchName,
        baseBranch,
        files,
        commitMessage: `grove: ${contribution.kind} ${cid}`,
      });

      // Create PR
      const result = await client.createPR({
        repo,
        title,
        body,
        head: branchName,
        base: baseBranch,
      });

      return {
        url: result.url,
        prNumber: result.number,
      };
    },

    /**
     * Import a GitHub PR as a grove contribution.
     *
     * Reads the PR diff, description, comments, and metadata. Stores the
     * diff as an artifact in CAS and creates a contribution in the store.
     *
     * @param ref - PR reference (owner/repo#number).
     */
    importFromPR: async (ref: PRRef): Promise<ImportResult> => {
      const pr = await client.getPR(ref);
      const diff = await client.getPRDiff(ref);

      // Store diff as artifact in CAS
      const artifacts: Record<string, string> = {};
      if (diff.length > 0) {
        const diffBytes = new TextEncoder().encode(diff);
        const hash = await cas.put(diffBytes, { mediaType: "text/x-diff" });
        artifacts.diff = hash;
      }

      // Store individual file patches as artifacts
      for (const file of pr.files) {
        if (file.patch) {
          const patchBytes = new TextEncoder().encode(file.patch);
          const hash = await cas.put(patchBytes, { mediaType: "text/x-diff" });
          artifacts[`patches/${file.filename}`] = hash;
        }
      }

      const input = prToContributionInput(pr, {
        repoRef: `${ref.owner}/${ref.repo}`,
        artifacts,
        agent,
      });

      const contribution = createContribution(input);
      await store.put(contribution);

      return { contribution };
    },

    /**
     * Import a GitHub Discussion as a grove contribution.
     *
     * Reads the Discussion body and comments, creating a discussion-kind
     * contribution with all metadata preserved in context.
     *
     * @param ref - Discussion reference (owner/repo#number).
     */
    importFromDiscussion: async (ref: DiscussionRef): Promise<ImportResult> => {
      const discussion = await client.getDiscussion(ref);

      const input = discussionToContributionInput(discussion, {
        repoRef: `${ref.owner}/${ref.repo}`,
        agent,
      });

      const contribution = createContribution(input);
      await store.put(contribution);

      return { contribution };
    },
  };
}
