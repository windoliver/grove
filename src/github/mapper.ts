/**
 * Mapping functions between Grove contributions and GitHub objects.
 *
 * All functions are pure — no I/O, no side effects. This makes them
 * trivially testable and keeps transformation logic separate from
 * GitHub API calls and store operations.
 *
 * Mapping is explicitly lossy: not everything round-trips perfectly.
 * GitHub metadata is preserved in contribution.context.github.
 * The design principle: "GitHub is a publication surface, NOT the
 * source of truth" (§7.3).
 */

import type { Contribution, ContributionInput, JsonValue } from "../core/models.js";
import { ContributionKind, ContributionMode, RelationType } from "../core/models.js";
import type { GitHubComment, GitHubDiscussion, GitHubPR, PRReviewComment } from "./types.js";

// ---------------------------------------------------------------------------
// Export: Contribution → GitHub
// ---------------------------------------------------------------------------

/** Shape returned by contributionToDiscussionBody. */
export interface DiscussionBody {
  readonly title: string;
  readonly body: string;
}

/**
 * Map a contribution to a GitHub Discussion title and body.
 *
 * The body includes:
 * - Summary and description
 * - Scores (if evaluation mode)
 * - Tags
 * - Relations (human-readable)
 * - Provenance footer with CID
 */
export function contributionToDiscussionBody(contribution: Contribution): DiscussionBody {
  const lines: string[] = [];

  // Summary as opening paragraph
  lines.push(contribution.summary);
  lines.push("");

  // Description
  if (contribution.description) {
    lines.push(contribution.description);
    lines.push("");
  }

  // Scores table (evaluation mode)
  if (contribution.scores && Object.keys(contribution.scores).length > 0) {
    lines.push("## Scores");
    lines.push("");
    lines.push("| Metric | Value | Direction | Unit |");
    lines.push("|--------|-------|-----------|------|");
    for (const [name, score] of Object.entries(contribution.scores)) {
      lines.push(`| ${name} | ${score.value} | ${score.direction} | ${score.unit ?? "—"} |`);
    }
    lines.push("");
  }

  // Tags
  if (contribution.tags.length > 0) {
    lines.push(`**Tags:** ${contribution.tags.join(", ")}`);
    lines.push("");
  }

  // Relations
  if (contribution.relations.length > 0) {
    lines.push("## Relations");
    lines.push("");
    for (const rel of contribution.relations) {
      lines.push(`- ${formatRelationType(rel.relationType)} \`${rel.targetCid}\``);
    }
    lines.push("");
  }

  // Agent info
  const agentParts: string[] = [];
  if (contribution.agent.agentName) agentParts.push(contribution.agent.agentName);
  if (contribution.agent.provider) agentParts.push(contribution.agent.provider);
  if (contribution.agent.model) agentParts.push(contribution.agent.model);
  if (agentParts.length > 0) {
    lines.push(`**Agent:** ${agentParts.join(" / ")}`);
    lines.push("");
  }

  // Provenance footer
  lines.push("---");
  lines.push(`> This discussion was generated from Grove contribution \`${contribution.cid}\``);
  lines.push(`> Kind: ${contribution.kind} | Mode: ${contribution.mode}`);
  lines.push(`> Created: ${contribution.createdAt}`);

  const title = `[grove:${contribution.kind}] ${contribution.summary}`;
  // GitHub title limit is 256 chars
  const truncatedTitle = title.length > 256 ? `${title.slice(0, 253)}...` : title;

  return {
    title: truncatedTitle,
    body: lines.join("\n"),
  };
}

/** Shape returned by contributionToPRBody. */
export interface PRBody {
  readonly title: string;
  readonly body: string;
  readonly branchName: string;
}

/**
 * Map a contribution to a GitHub PR title, body, and branch name.
 *
 * The PR body includes the contribution summary, description,
 * and a provenance note.
 */
export function contributionToPRBody(contribution: Contribution): PRBody {
  const lines: string[] = [];

  lines.push("## Summary");
  lines.push("");
  lines.push(contribution.summary);
  lines.push("");

  if (contribution.description) {
    lines.push("## Description");
    lines.push("");
    lines.push(contribution.description);
    lines.push("");
  }

  if (contribution.tags.length > 0) {
    lines.push(`**Tags:** ${contribution.tags.join(", ")}`);
    lines.push("");
  }

  lines.push("---");
  lines.push(`> This PR was generated from Grove contribution \`${contribution.cid}\``);
  lines.push(`> Kind: ${contribution.kind} | Mode: ${contribution.mode}`);
  lines.push(`> Created: ${contribution.createdAt}`);
  lines.push("");
  lines.push("> **Note:** This PR is for visibility/publication. It was NOT created for merging.");

  const title = `[grove:${contribution.kind}] ${contribution.summary}`;
  const truncatedTitle = title.length > 256 ? `${title.slice(0, 253)}...` : title;

  // Branch name from CID (first 12 chars of hash)
  const cidShort = contribution.cid.replace("blake3:", "").slice(0, 12);
  const branchName = `grove/${contribution.kind}/${cidShort}`;

  return {
    title: truncatedTitle,
    body: lines.join("\n"),
    branchName,
  };
}

// ---------------------------------------------------------------------------
// Import: GitHub → Contribution
// ---------------------------------------------------------------------------

/**
 * Map a GitHub PR (with diff and comments) to a ContributionInput.
 *
 * The PR diff is stored as a named artifact. PR metadata (author,
 * number, repo, comments, review comments, files) is preserved in
 * contribution.context.github.
 */
export function prToContributionInput(
  pr: GitHubPR,
  options: {
    /** Owner/repo string. */
    readonly repoRef: string;
    /** Map of artifact name → content hash (pre-stored in CAS). */
    readonly artifacts: Readonly<Record<string, string>>;
    /** Agent identity for the contribution. */
    readonly agent: ContributionInput["agent"];
  },
): ContributionInput {
  return {
    kind: ContributionKind.Work,
    mode: ContributionMode.Exploration,
    summary: `[GitHub PR #${pr.number}] ${pr.title}`,
    description: pr.body || undefined,
    artifacts: { ...options.artifacts },
    relations: [],
    tags: ["github-import", "pull-request"],
    context: {
      github: {
        type: "pull_request",
        repo: options.repoRef,
        number: pr.number,
        url: pr.url,
        author: pr.author,
        state: pr.state,
        baseBranch: pr.baseBranch,
        headBranch: pr.headBranch,
        createdAt: pr.createdAt,
        filesChanged: pr.files.length,
        comments: pr.comments.map(commentToContext),
        reviewComments: pr.reviewComments.map(reviewCommentToContext),
      } as Record<string, JsonValue>,
    },
    agent: options.agent,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Map a GitHub Discussion to a ContributionInput.
 *
 * Discussion body becomes the contribution description. Comments
 * and replies are preserved in contribution.context.github.
 */
export function discussionToContributionInput(
  discussion: GitHubDiscussion,
  options: {
    readonly repoRef: string;
    readonly agent: ContributionInput["agent"];
  },
): ContributionInput {
  return {
    kind: ContributionKind.Discussion,
    mode: ContributionMode.Exploration,
    summary: `[GitHub Discussion #${discussion.number}] ${discussion.title}`,
    description: discussion.body || undefined,
    artifacts: {},
    relations: [],
    tags: ["github-import", "discussion"],
    context: {
      github: {
        type: "discussion",
        repo: options.repoRef,
        number: discussion.number,
        url: discussion.url,
        author: discussion.author,
        categoryName: discussion.categoryName,
        createdAt: discussion.createdAt,
        comments: discussion.comments.map(discussionCommentToContext),
      } as Record<string, JsonValue>,
    },
    agent: options.agent,
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function formatRelationType(type: string): string {
  switch (type) {
    case RelationType.DerivesFrom:
      return "Derives from";
    case RelationType.RespondsTo:
      return "Responds to";
    case RelationType.Reviews:
      return "Reviews";
    case RelationType.Reproduces:
      return "Reproduces";
    case RelationType.Adopts:
      return "Adopts";
    default:
      return type;
  }
}

function commentToContext(c: GitHubComment): Record<string, JsonValue> {
  return {
    id: c.id,
    body: c.body,
    author: c.author,
    createdAt: c.createdAt,
  };
}

function reviewCommentToContext(c: PRReviewComment): Record<string, JsonValue> {
  return {
    id: c.id,
    body: c.body,
    author: c.author,
    createdAt: c.createdAt,
    path: c.path,
    ...(c.line !== undefined ? { line: c.line } : {}),
  };
}

function discussionCommentToContext(c: {
  readonly id: string;
  readonly body: string;
  readonly author: string;
  readonly createdAt: string;
  readonly isAnswer: boolean;
  readonly replies: readonly GitHubComment[];
}): Record<string, JsonValue> {
  return {
    id: c.id,
    body: c.body,
    author: c.author,
    createdAt: c.createdAt,
    isAnswer: c.isAnswer,
    replies: c.replies.map(commentToContext) as JsonValue,
  };
}
