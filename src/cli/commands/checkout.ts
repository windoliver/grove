/**
 * grove checkout — materialize a contribution's artifacts into a directory.
 *
 * Uses the shared operations layer for frontier resolution and contribution
 * lookup, while keeping CLI-specific artifact staging (atomic rename to --to).
 *
 * Usage:
 *   grove checkout blake3:abc123 --to ./workspace/
 *   grove checkout --frontier throughput --to ./workspace/
 *   grove checkout blake3:abc123 --to ./workspace/ --json
 */

import { mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { frontierOperation } from "../../core/operations/index.js";
import {
  assertWithinBoundary,
  ensureArtifactParentDir,
  validateArtifactName,
} from "../../core/path-safety.js";
import type { CliDeps, Writer } from "../context.js";
import { outputJson, outputJsonError, truncateCid } from "../format.js";
import { toOperationDeps } from "../operation-adapter.js";

export interface CheckoutOptions {
  readonly cid?: string | undefined;
  readonly frontierMetric?: string | undefined;
  readonly to: string;
  readonly agent: string;
  readonly json?: boolean | undefined;
}

export function parseCheckoutArgs(argv: string[]): CheckoutOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      to: { type: "string" },
      frontier: { type: "string" },
      agent: { type: "string", default: "cli-user" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (values.to === undefined) {
    throw new Error("Missing required --to <directory> option.");
  }

  const cid = positionals[0];
  const frontierMetric = values.frontier;

  if (cid === undefined && frontierMetric === undefined) {
    throw new Error("Provide a CID positional argument or --frontier <metric>.");
  }

  if (cid !== undefined && frontierMetric !== undefined) {
    throw new Error("Provide either a CID or --frontier, not both.");
  }

  return {
    cid,
    frontierMetric,
    to: values.to,
    agent: values.agent ?? "cli-user",
    json: values.json ?? false,
  };
}

export async function runCheckout(
  options: CheckoutOptions,
  deps: CliDeps,
  writer: Writer = console.log,
): Promise<void> {
  const opDeps = toOperationDeps(deps);
  let targetCid: string;

  if (options.cid !== undefined) {
    targetCid = options.cid;
  } else {
    // Resolve CID from frontier metric using the operations layer
    const result = await frontierOperation({ metric: options.frontierMetric, limit: 1 }, opDeps);

    if (!result.ok) {
      if (options.json) {
        outputJsonError(result.error);
        return;
      }
      throw new Error(result.error.message);
    }

    const metricEntries = options.frontierMetric
      ? result.value.byMetric[options.frontierMetric]
      : undefined;

    if (metricEntries === undefined || metricEntries.length === 0) {
      const errMsg = `No frontier entries found for metric '${options.frontierMetric}'.`;
      if (options.json) {
        outputJsonError({ code: "NOT_FOUND", message: errMsg });
        return;
      }
      throw new Error(errMsg);
    }

    const best = metricEntries[0];
    if (best === undefined) {
      const errMsg = `No frontier entries found for metric '${options.frontierMetric}'.`;
      if (options.json) {
        outputJsonError({ code: "NOT_FOUND", message: errMsg });
        return;
      }
      throw new Error(errMsg);
    }
    targetCid = best.cid;
    if (!options.json) {
      writer(`Resolved frontier best for '${options.frontierMetric}': ${truncateCid(targetCid)}`);
    }
  }

  // Verify contribution exists
  const contribution = await deps.store.get(targetCid);
  if (contribution === undefined) {
    const errMsg = `Contribution '${targetCid}' not found.`;
    if (options.json) {
      outputJsonError({ code: "NOT_FOUND", message: errMsg });
      return;
    }
    throw new Error(errMsg);
  }

  // Stage artifacts into a temp directory, then atomically swap into --to.
  // This prevents two failure modes:
  //   1. Stale files left behind when re-checking out into the same directory
  //   2. Partial snapshots when a later artifact is missing from CAS
  const destDir = resolve(options.to);
  const stagingDir = join(
    tmpdir(),
    `grove-checkout-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(stagingDir, { recursive: true });

  try {
    for (const [name, contentHash] of Object.entries(contribution.artifacts)) {
      validateArtifactName(name);
      const stagedPath = join(stagingDir, name);
      await assertWithinBoundary(stagedPath, stagingDir);
      await ensureArtifactParentDir(name, stagingDir);

      const found = await deps.cas.getToFile(contentHash, stagedPath);
      if (!found) {
        throw new Error(`Artifact '${name}' with hash '${contentHash}' not found in CAS.`);
      }
    }

    // All artifacts staged successfully — swap into destination.
    // Remove existing destination first to prevent stale files.
    await rm(destDir, { recursive: true, force: true });
    await mkdir(join(destDir, ".."), { recursive: true });
    await rename(stagingDir, destDir);
  } catch (err) {
    // Clean up staging dir on failure — destination is untouched
    await rm(stagingDir, { recursive: true, force: true });
    throw err;
  }

  const artifactCount = Object.keys(contribution.artifacts).length;

  if (options.json) {
    outputJson({
      cid: targetCid,
      destination: destDir,
      kind: contribution.kind,
      summary: contribution.summary,
      artifactCount,
    });
    return;
  }

  writer(`Checked out ${truncateCid(targetCid)} to ${destDir}`);
  writer(`  Kind: ${contribution.kind}`);
  writer(`  Summary: ${contribution.summary}`);
  writer(`  Artifacts: ${artifactCount}`);
}
