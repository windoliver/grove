/**
 * Grove CLI — command-line interface for the contribution graph.
 *
 * Commands:
 *   grove init          — Create a new grove
 *   grove contribute    — Submit a contribution
 *   grove claim         — Claim work
 *   grove release       — Release a claim
 *   grove claims        — List claims
 *   grove checkout      — Materialize contribution artifacts
 *   grove frontier      — Show current frontier
 *   grove search        — Search contributions
 *   grove log           — Recent contributions
 *   grove tree          — DAG visualization
 */

import { createSqliteStores } from "../local/sqlite-store.js";
import { runClaim } from "./commands/claim.js";
import { runClaims } from "./commands/claims.js";
import { runRelease } from "./commands/release.js";
import { resolveGroveDir } from "./utils/grove-dir.js";

type CommandHandler = (args: readonly string[], deps: CommandDeps) => Promise<void>;

interface CommandDeps {
  readonly claimStore: import("../core/store.js").ClaimStore;
  readonly stdout: (msg: string) => void;
  readonly stderr: (msg: string) => void;
}

const COMMANDS: Record<string, CommandHandler> = {
  claim: runClaim,
  release: runRelease,
  claims: runClaims,
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Extract global --grove option before subcommand
  let groveOverride: string | undefined;
  const filteredArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--grove" && i + 1 < args.length) {
      groveOverride = args[i + 1];
      i++; // skip value
    } else {
      filteredArgs.push(args[i] ?? "");
    }
  }

  const command = filteredArgs[0];
  const subArgs = filteredArgs.slice(1);

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "--version" || command === "-v") {
    console.log("grove 0.1.0");
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`grove: unknown command '${command}'. Run 'grove --help' for usage.`);
    process.exitCode = 1;
    return;
  }

  const { dbPath } = resolveGroveDir(groveOverride);
  const stores = createSqliteStores(dbPath);

  try {
    await handler(subArgs, {
      claimStore: stores.claimStore,
      stdout: (msg) => console.log(msg),
      stderr: (msg) => console.error(msg),
    });
  } finally {
    stores.close();
  }
}

function printUsage(): void {
  console.log(`grove — asynchronous multi-agent contribution graph

Usage:
  grove claim <target>        Claim work to prevent duplication
  grove release <claim-id>    Release a claim
  grove claims                List claims

  grove init [name]           Create a new grove
  grove contribute            Submit a contribution
  grove checkout <cid>        Materialize contribution artifacts
  grove frontier              Show current frontier
  grove search [query]        Search contributions
  grove log                   Recent contributions
  grove tree                  DAG visualization

Global options:
  --grove <path>              Path to grove directory (or set GROVE_DIR)
  --help, -h                  Show this help message
  --version, -v               Show version`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`grove: ${message}`);
  process.exitCode = 1;
});
