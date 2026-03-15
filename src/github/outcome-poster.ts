/**
 * Post contribution outcomes back to GitHub as check runs and PR comments.
 *
 * When an agent's contribution is accepted/rejected, this posts
 * the result to the associated PR for visibility.
 *
 * (Issue #90, Feature 4: Outcome -> GitHub)
 */

import { spawnCommand } from "../core/subprocess.js";

/**
 * Post a contribution outcome as a PR comment.
 * Uses `gh pr comment` to add a structured comment.
 */
export async function postOutcomeComment(opts: {
  readonly prNumber: number;
  readonly cid: string;
  readonly summary: string;
  readonly outcome: "accepted" | "rejected" | "crashed";
  readonly agentName?: string;
  readonly scores?: Record<string, number>;
}): Promise<void> {
  const icon =
    opts.outcome === "accepted"
      ? "\u2705"
      : opts.outcome === "rejected"
        ? "\u274C"
        : "\uD83D\uDCA5";
  const scoreLines = opts.scores
    ? Object.entries(opts.scores)
        .map(([k, v]) => `- **${k}**: ${String(v)}`)
        .join("\n")
    : "";

  const body = [
    `### ${icon} Grove: Contribution ${opts.outcome}`,
    "",
    `**CID**: \`${opts.cid.slice(0, 20)}\u2026\``,
    `**Summary**: ${opts.summary}`,
    ...(opts.agentName ? [`**Agent**: ${opts.agentName}`] : []),
    ...(scoreLines ? ["", "**Scores**:", scoreLines] : []),
  ].join("\n");

  try {
    await spawnCommand(["gh", "pr", "comment", String(opts.prNumber), "--body", body], {
      timeoutMs: 15_000,
    });
  } catch {
    // gh CLI unavailable or comment failed — non-fatal
  }
}

/**
 * Post a check run status for a contribution.
 * Uses `gh api` to create a check run on the PR's head commit.
 */
export async function postCheckRun(opts: {
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly name: string;
  readonly conclusion: "success" | "failure" | "neutral";
  readonly summary: string;
  readonly details?: string;
}): Promise<void> {
  const payload = JSON.stringify({
    name: opts.name,
    head_sha: opts.headSha,
    conclusion: opts.conclusion,
    output: {
      title: opts.name,
      summary: opts.summary,
      ...(opts.details !== undefined ? { text: opts.details } : {}),
    },
  });

  try {
    const proc = Bun.spawn(
      [
        "gh",
        "api",
        `repos/${opts.owner}/${opts.repo}/check-runs`,
        "--method",
        "POST",
        "--input",
        "-",
      ],
      { stdout: "pipe", stderr: "pipe", stdin: new Blob([payload]) },
    );
    await proc.exited;
  } catch {
    // gh CLI unavailable or API call failed — non-fatal
  }
}
