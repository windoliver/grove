/**
 * Periodic workspace garbage collector for TUI mode.
 *
 * Scans the workspace directory and cleans orphaned workspaces
 * whose claims are no longer active in the provider.
 */

import { safeCleanup } from "../shared/safe-cleanup.js";
import type { TuiDataProvider } from "./provider.js";

/** Default GC interval: 5 minutes. */
const GC_INTERVAL_MS = 5 * 60 * 1_000;

/**
 * Start periodic workspace GC.
 *
 * Returns a cleanup function that stops the GC timer.
 * On each tick:
 * 1. Fetches all claims from the provider
 * 2. Fetches all claims that are active
 * 3. Identifies workspaces (via claims with workspace context) that are orphaned
 * 4. Calls cleanWorkspace for each orphaned workspace
 */
export function startWorkspaceGc(
  provider: TuiDataProvider,
  intervalMs: number = GC_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    void safeCleanup(runGc(provider), "workspace GC tick", { silent: true });
  }, intervalMs);

  return () => clearInterval(timer);
}

async function runGc(provider: TuiDataProvider): Promise<void> {
  if (!provider.cleanWorkspace) return;

  // Get all claims (not just active) to find released/expired ones with workspaces
  const allClaims = await provider.getClaims({ status: "all" });
  const activeClaims = await provider.getClaims({ status: "active" });

  const activeTargetRefs = new Set(activeClaims.map((c) => c.targetRef));

  for (const claim of allClaims) {
    // Skip active claims — their workspaces are in use
    if (activeTargetRefs.has(claim.targetRef)) continue;

    // Only clean workspaces for non-active claims that had workspace context
    if (claim.status !== "active" && claim.context?.workspacePath !== undefined) {
      try {
        await provider.cleanWorkspace(claim.targetRef, claim.agent.agentId);
      } catch {
        // Workspace may already be cleaned — ignore
      }
    }
  }
}
