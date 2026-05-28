/**
 * Grove CLI context — discovers the .grove directory and initializes stores.
 *
 * Walks up from the current working directory to find the nearest .grove/
 * directory, opens the SQLite database, and returns all stores needed by
 * CLI commands.
 */

import { resolve } from "node:path";
import type {
  AdmissionGovernanceEvaluator,
  AdmissionPermissionResolver,
  ArtifactSignatureVerifier,
  BlueprintHashSource,
} from "../core/admission/types.js";
import type { FrontierCalculator } from "../core/frontier.js";
import type { HookRunner } from "../core/hooks.js";
import type { OutcomeStore } from "../core/outcome.js";
import type { ClaimStore, ContributionStore } from "../core/store.js";
import type { TimelineStore } from "../core/timeline-store.js";
import type { WorkspaceManager } from "../core/workspace.js";
import type { FsCas } from "../local/fs-cas.js";
import { createLocalRuntime } from "../local/runtime.js";
import { findGroveDir } from "./utils/grove-dir.js";

export { findGroveDir };

/** All dependencies a CLI command needs. */
export interface CliDeps {
  readonly store: ContributionStore;
  readonly claimStore: ClaimStore;
  readonly timelineStore?: TimelineStore | undefined;
  readonly frontier: FrontierCalculator;
  readonly workspace: WorkspaceManager;
  readonly cas: FsCas;
  readonly groveRoot: string;
  readonly outcomeStore?: OutcomeStore | undefined;
  readonly hookRunner?: HookRunner | undefined;
  readonly hookCwd?: string | undefined;
  readonly admissionPermissionResolver?: AdmissionPermissionResolver | undefined;
  readonly admissionGovernanceEvaluator?: AdmissionGovernanceEvaluator | undefined;
  readonly blueprintHashSource?: BlueprintHashSource | undefined;
  readonly artifactSignatureVerifier?: ArtifactSignatureVerifier | undefined;
  readonly zoneId?: string | undefined;
  readonly close: () => void;
}

/** Writer function for testable output. */
export type Writer = (text: string) => void;

/**
 * Discover the grove and initialize all stores.
 * Throws with a user-friendly message if no .grove directory is found.
 */
export function initCliDeps(cwd: string, groveOverride?: string): CliDeps {
  const groveDir = groveOverride ? resolve(groveOverride) : findGroveDir(cwd);
  if (groveDir === undefined) {
    throw new Error(
      "Not inside a grove. Run 'grove init' to create one, or navigate to an existing grove.",
    );
  }

  const runtime = createLocalRuntime({
    groveDir,
    frontierCacheTtlMs: 0, // CLI commands are single-shot; no caching needed
    workspace: true,
  });

  if (!runtime.workspace) {
    throw new Error("Workspace manager failed to initialize");
  }

  return {
    store: runtime.contributionStore,
    claimStore: runtime.claimStore,
    timelineStore: runtime.timelineStore,
    frontier: runtime.frontier,
    workspace: runtime.workspace,
    cas: runtime.cas,
    groveRoot: runtime.groveRoot,
    outcomeStore: runtime.outcomeStore,
    hookRunner: runtime.hookRunner,
    hookCwd: runtime.hookCwd,
    admissionPermissionResolver: runtime.admissionPermissionResolver,
    admissionGovernanceEvaluator: runtime.admissionGovernanceEvaluator,
    blueprintHashSource: runtime.blueprintHashSource,
    artifactSignatureVerifier: runtime.artifactSignatureVerifier,
    zoneId: runtime.zoneId,
    close: runtime.close,
  };
}
