/**
 * Detect the active PR for the current git branch.
 * Uses `gh pr view --json` to get PR details.
 */

import type { GitHubPRSummary } from "../tui/provider.js";

/**
 * Get the active PR for the current branch, if any.
 * Returns undefined if no PR exists or gh CLI is unavailable.
 */
export async function getActivePR(): Promise<GitHubPRSummary | undefined> {
  try {
    const proc = Bun.spawn(
      [
        "gh",
        "pr",
        "view",
        "--json",
        "number,title,state,additions,deletions,changedFiles,reviewDecision,statusCheckRollup",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) return undefined;

    const data = JSON.parse(output) as {
      number: number;
      title: string;
      state: string;
      additions: number;
      deletions: number;
      changedFiles: number;
      reviewDecision: string;
      statusCheckRollup: readonly { state: string }[] | null;
    };

    // Compute checks status from statusCheckRollup
    const checks = data.statusCheckRollup ?? [];
    const totalChecks = checks.length;
    const passedChecks = checks.filter(
      (c) => c.state === "SUCCESS" || c.state === "NEUTRAL" || c.state === "SKIPPED",
    ).length;
    const failedChecks = checks.filter((c) => c.state === "FAILURE" || c.state === "ERROR").length;

    let checksStatus = "none";
    if (totalChecks > 0) {
      if (failedChecks > 0) checksStatus = `${failedChecks}/${totalChecks} failed`;
      else if (passedChecks === totalChecks) checksStatus = `${totalChecks}/${totalChecks} passed`;
      else checksStatus = `${passedChecks}/${totalChecks} passed`;
    }

    // Map review decision
    let reviewStatus = "none";
    if (data.reviewDecision === "APPROVED") reviewStatus = "approved";
    else if (data.reviewDecision === "CHANGES_REQUESTED") reviewStatus = "changes requested";
    else if (data.reviewDecision === "REVIEW_REQUIRED") reviewStatus = "review required";

    return {
      number: data.number,
      title: data.title,
      state: data.state.toLowerCase(),
      checksStatus,
      reviewStatus,
      filesChanged: data.changedFiles,
      additions: data.additions,
      deletions: data.deletions,
    };
  } catch {
    return undefined;
  }
}
