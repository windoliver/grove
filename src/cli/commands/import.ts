/**
 * grove import — import a GitHub PR or Discussion as a contribution.
 *
 * Usage:
 *   grove import --from-pr owner/repo#44
 *   grove import --from-discussion owner/repo#43
 */

import { parseArgs } from "node:util";
import { createGitHubAdapter } from "../../github/adapter.js";
import { createGhCliClient } from "../../github/gh-cli-client.js";
import { parseDiscussionRef, parsePRRef } from "../../github/refs.js";
import { initCliDeps } from "../context.js";
import { truncateCid } from "../format.js";

export interface ImportOptions {
  readonly fromPR: boolean;
  readonly fromDiscussion: boolean;
  readonly ref: string;
}

export function parseImportArgs(argv: readonly string[]): ImportOptions {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      "from-pr": { type: "boolean", default: false },
      "from-discussion": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const fromPR = values["from-pr"] ?? false;
  const fromDiscussion = values["from-discussion"] ?? false;

  if (!fromPR && !fromDiscussion) {
    throw new Error("Specify --from-pr or --from-discussion.");
  }

  if (fromPR && fromDiscussion) {
    throw new Error("Specify only one of --from-pr or --from-discussion.");
  }

  if (positionals.length < 1) {
    throw new Error("Usage: grove import --from-pr <owner/repo#number>");
  }

  // Length check above guarantees this exists
  const ref = positionals[0] as string;

  // Validate ref early
  if (fromPR) {
    parsePRRef(ref);
  } else {
    parseDiscussionRef(ref);
  }

  return { fromPR, fromDiscussion, ref };
}

export async function handleImport(argv: readonly string[], groveOverride?: string): Promise<void> {
  // Check for --help before strict arg parsing
  if (argv.includes("--help") || argv.includes("-h")) {
    printImportHelp();
    return;
  }

  const options = parseImportArgs(argv);

  const deps = initCliDeps(process.cwd(), groveOverride);
  try {
    const client = await createGhCliClient();

    const adapter = createGitHubAdapter({
      client,
      store: deps.store,
      cas: deps.cas,
      agent: { agentId: "grove-cli", agentName: "grove-import" },
    });

    if (options.fromPR) {
      const prRef = parsePRRef(options.ref);
      const result = await adapter.importFromPR(prRef);
      console.log(
        `Imported PR #${prRef.number} as contribution ${truncateCid(result.contribution.cid)}`,
      );
      console.log(`  Kind: ${result.contribution.kind}`);
      console.log(`  Summary: ${result.contribution.summary}`);
      console.log(`  CID: ${result.contribution.cid}`);
    } else {
      const discRef = parseDiscussionRef(options.ref);
      const result = await adapter.importFromDiscussion(discRef);
      console.log(
        `Imported Discussion #${discRef.number} as contribution ${truncateCid(result.contribution.cid)}`,
      );
      console.log(`  Kind: ${result.contribution.kind}`);
      console.log(`  Summary: ${result.contribution.summary}`);
      console.log(`  CID: ${result.contribution.cid}`);
    }
  } finally {
    deps.close();
  }
}

function printImportHelp(): void {
  console.log(`grove import — import from GitHub as a contribution

Usage:
  grove import --from-pr <owner/repo#number>
  grove import --from-discussion <owner/repo#number>

Options:
  --from-pr           Import a GitHub Pull Request
  --from-discussion   Import a GitHub Discussion

Examples:
  grove import --from-pr windoliver/myproject#44
  grove import --from-discussion windoliver/myproject#43`);
}
