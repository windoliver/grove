/**
 * Grove CLI — command-line interface for the contribution graph.
 *
 * Commands:
 *   grove init          — Create a new grove
 *   grove contribute    — Submit a contribution
 *   grove claim         — Claim work
 *   grove release       — Release a claim
 *   grove checkout      — Materialize contribution artifacts
 *   grove frontier      — Show current frontier
 *   grove search        — Search contributions
 *   grove log           — Recent contributions
 *   grove tree          — DAG visualization
 *
 * TODO: Implement in #11, #12, #13
 */

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  console.error(`grove: unknown command '${command}'. Run 'grove --help' for usage.`);
  process.exit(1);
}

function printUsage(): void {
  console.log(`grove — asynchronous multi-agent contribution graph

Usage:
  grove init [name]           Create a new grove
  grove contribute            Submit a contribution
  grove claim <target>        Claim work to prevent duplication
  grove release <claim-id>    Release a claim
  grove checkout <cid>        Materialize contribution artifacts
  grove frontier              Show current frontier
  grove search [query]        Search contributions
  grove log                   Recent contributions
  grove tree                  DAG visualization

Options:
  --help, -h                  Show this help message
  --version, -v               Show version`);
}

main();
