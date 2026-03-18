/**
 * Grove CLI context — discovers the .grove directory and initializes stores.
 *
 * Walks up from the current working directory to find the nearest .grove/
 * directory, opens the SQLite database, and returns all stores needed by
 * CLI commands.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ContentStore } from "../core/cas.js";
import { parseGroveConfig } from "../core/config.js";
import type { FrontierCalculator } from "../core/frontier.js";
import { DefaultFrontierCalculator } from "../core/frontier.js";
import type { OutcomeStore } from "../core/outcome.js";
import type { ClaimStore, ContributionStore } from "../core/store.js";
import type { WorkspaceManager } from "../core/workspace.js";
import { createLocalRuntime } from "../local/runtime.js";
import { NexusCas } from "../nexus/nexus-cas.js";
import { NexusClaimStore } from "../nexus/nexus-claim-store.js";
import { NexusContributionStore } from "../nexus/nexus-contribution-store.js";
import { NexusHttpClient } from "../nexus/nexus-http-client.js";
import { NexusOutcomeStore } from "../nexus/nexus-outcome-store.js";

const GROVE_DIR = ".grove";

/** All dependencies a CLI command needs. */
export interface CliDeps {
  readonly store: ContributionStore;
  readonly claimStore: ClaimStore;
  readonly frontier: FrontierCalculator;
  readonly workspace: WorkspaceManager;
  readonly cas: ContentStore;
  readonly groveRoot: string;
  readonly outcomeStore?: OutcomeStore | undefined;
  readonly close: () => void;
}

/** Writer function for testable output. */
export type Writer = (text: string) => void;

/**
 * Walk up from `startDir` to find the nearest directory containing `.grove/`.
 * Returns the absolute path to the `.grove` directory, or undefined.
 */
export function findGroveDir(startDir: string): string | undefined {
  let dir = resolve(startDir);
  const root = dirname(dir) === dir ? dir : undefined;

  while (true) {
    const candidate = join(dir, GROVE_DIR);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  // Check filesystem root
  if (root !== undefined) {
    const candidate = join(root, GROVE_DIR);
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}

/**
 * Discover the grove and initialize all stores.
 * Throws with a user-friendly message if no .grove directory is found.
 */
export function initCliDeps(cwd: string, groveOverride?: string): CliDeps {
  // Priority: explicit override > GROVE_DIR env > walk-up detection
  const effectiveOverride = groveOverride || process.env.GROVE_DIR || undefined;
  const groveDir = effectiveOverride ? resolve(effectiveOverride) : findGroveDir(cwd);
  if (groveDir === undefined) {
    throw new Error(
      "Not inside a grove. Run 'grove init' to create one, or navigate to an existing grove.",
    );
  }

  // Use nexus-backed stores when grove.json declares mode "nexus"
  const configPath = join(groveDir, "grove.json");
  if (existsSync(configPath)) {
    try {
      const groveConfig = parseGroveConfig(readFileSync(configPath, "utf-8"));
      // Resolve Nexus URL: grove.json nexusUrl > GROVE_NEXUS_URL env > nexus.yaml port discovery
      const nexusUrl =
        groveConfig.nexusUrl ||
        process.env.GROVE_NEXUS_URL ||
        (groveConfig.nexusManaged
          ? (() => {
              const { readNexusUrl } =
                require("../cli/nexus-lifecycle.js") as typeof import("../cli/nexus-lifecycle.js");
              return readNexusUrl(join(groveDir, ".."));
            })()
          : undefined);
      if (groveConfig.mode === "nexus" && nexusUrl) {
        const apiKey = process.env.NEXUS_API_KEY || undefined;
        const client = new NexusHttpClient({ url: nexusUrl, apiKey });
        const nexusConfig = { client, zoneId: "default" };

        const store = new NexusContributionStore(nexusConfig);
        const claimStore = new NexusClaimStore(nexusConfig);
        const outcomeStore = new NexusOutcomeStore(nexusConfig);
        const cas = new NexusCas(nexusConfig);
        const frontier = new DefaultFrontierCalculator(store);

        // Local runtime only for workspace manager (needs SQLite for tracking)
        const runtime = createLocalRuntime({ groveDir, frontierCacheTtlMs: 0, workspace: true });

        return {
          store,
          claimStore,
          frontier,
          workspace:
            runtime.workspace ??
            (() => {
              throw new Error("Workspace manager failed");
            })(),
          cas,
          groveRoot: resolve(groveDir, ".."),
          outcomeStore,
          close: () => {
            runtime.close();
          },
        };
      }
    } catch {
      // Config parse failed — fall through to local stores
    }
  }

  const runtime = createLocalRuntime({
    groveDir,
    frontierCacheTtlMs: 0,
    workspace: true,
  });

  if (!runtime.workspace) {
    throw new Error("Workspace manager failed to initialize");
  }

  return {
    store: runtime.contributionStore,
    claimStore: runtime.claimStore,
    frontier: runtime.frontier,
    workspace: runtime.workspace,
    cas: runtime.cas,
    groveRoot: runtime.groveRoot,
    outcomeStore: runtime.outcomeStore,
    close: runtime.close,
  };
}
