/**
 * grove export — export a contribution to GitHub.
 *
 * Usage:
 *   grove export --to-discussion owner/repo blake3:abc123
 *   grove export --to-discussion owner/repo blake3:abc123 --category Ideas
 *   grove export --to-pr owner/repo blake3:abc123
 */

import { parseArgs } from "node:util";
import { createGitHubAdapter } from "../../github/adapter.js";
import { createGhCliClient } from "../../github/gh-cli-client.js";
import { parseRepoRef } from "../../github/refs.js";
import { initCliDeps } from "../context.js";

export interface ExportOptions {
  readonly toDiscussion: boolean;
  readonly toPR: boolean;
  readonly repoRef: string;
  readonly cid: string;
  readonly category: string;
}

export function parseExportArgs(argv: readonly string[]): ExportOptions {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      "to-discussion": { type: "boolean", default: false },
      "to-pr": { type: "boolean", default: false },
      category: { type: "string", default: "General" },
    },
    strict: true,
    allowPositionals: true,
  });

  const toDiscussion = values["to-discussion"] ?? false;
  const toPR = values["to-pr"] ?? false;

  if (!toDiscussion && !toPR) {
    throw new Error("Specify --to-discussion or --to-pr.");
  }

  if (toDiscussion && toPR) {
    throw new Error("Specify only one of --to-discussion or --to-pr.");
  }

  if (positionals.length < 2) {
    throw new Error("Usage: grove export --to-discussion <owner/repo> <cid>");
  }

  // Length check above guarantees these exist
  const repoRef = positionals[0] as string;
  const cid = positionals[1] as string;
  const category = values.category ?? "General";

  // Validate repo ref early
  parseRepoRef(repoRef);

  return { toDiscussion, toPR, repoRef, cid, category };
}

export async function handleExport(argv: readonly string[], groveOverride?: string): Promise<void> {
  // Check for --help before strict arg parsing
  if (argv.includes("--help") || argv.includes("-h")) {
    printExportHelp();
    return;
  }

  const options = parseExportArgs(argv);

  const deps = initCliDeps(process.cwd(), groveOverride);
  try {
    const client = await createGhCliClient();
    const repo = parseRepoRef(options.repoRef);

    const adapter = createGitHubAdapter({
      client,
      store: deps.store,
      cas: deps.cas,
      agent: { agentId: "grove-cli", agentName: "grove-export" },
    });

    if (options.toDiscussion) {
      const result = await adapter.exportToDiscussion(repo, options.cid, options.category);
      console.log(`Discussion created: ${result.url}`);
    } else {
      const result = await adapter.exportToPR(repo, options.cid);
      console.log(`PR created: ${result.url}`);
    }
  } finally {
    deps.close();
  }
}

function printExportHelp(): void {
  console.log(`grove export — export a contribution to GitHub

Usage:
  grove export --to-discussion <owner/repo> <cid> [--category <name>]
  grove export --to-pr <owner/repo> <cid>

Options:
  --to-discussion    Export as a GitHub Discussion
  --to-pr            Export as a GitHub Pull Request
  --category <name>  Discussion category (default: "General")

Examples:
  grove export --to-discussion windoliver/grove blake3:abc123
  grove export --to-pr windoliver/myproject blake3:abc123 --category Ideas`);
}
