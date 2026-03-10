/**
 * grove checkout — materialize a contribution's artifacts into a directory.
 *
 * Usage:
 *   grove checkout blake3:abc123 --to ./workspace/
 *   grove checkout --frontier throughput --to ./workspace/
 */

import { mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  assertWithinBoundary,
  ensureArtifactParentDir,
  validateArtifactName,
} from "../../core/path-safety.js";
import type { CliDeps, Writer } from "../context.js";
import { truncateCid } from "../format.js";

export interface CheckoutOptions {
  readonly cid?: string | undefined;
  readonly frontierMetric?: string | undefined;
  readonly to: string;
  readonly agent: string;
}

export function parseCheckoutArgs(argv: string[]): CheckoutOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      to: { type: "string" },
      frontier: { type: "string" },
      agent: { type: "string", default: "cli-user" },
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
  };
}

export async function runCheckout(
  options: CheckoutOptions,
  deps: CliDeps,
  writer: Writer = console.log,
): Promise<void> {
  let targetCid: string;

  if (options.cid !== undefined) {
    targetCid = options.cid;
  } else {
    // Resolve CID from frontier metric
    const frontier = await deps.frontier.compute({ metric: options.frontierMetric, limit: 1 });
    const metricEntries = options.frontierMetric
      ? frontier.byMetric[options.frontierMetric]
      : undefined;

    if (metricEntries === undefined || metricEntries.length === 0) {
      throw new Error(`No frontier entries found for metric '${options.frontierMetric}'.`);
    }

    const best = metricEntries[0];
    if (best === undefined) {
      throw new Error(`No frontier entries found for metric '${options.frontierMetric}'.`);
    }
    targetCid = best.cid;
    writer(`Resolved frontier best for '${options.frontierMetric}': ${truncateCid(targetCid)}`);
  }

  // Verify contribution exists
  const contribution = await deps.store.get(targetCid);
  if (contribution === undefined) {
    throw new Error(`Contribution '${targetCid}' not found.`);
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
  writer(`Checked out ${truncateCid(targetCid)} to ${destDir}`);
  writer(`  Kind: ${contribution.kind}`);
  writer(`  Summary: ${contribution.summary}`);
  writer(`  Artifacts: ${artifactCount}`);
}
