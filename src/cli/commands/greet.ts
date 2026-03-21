/**
 * `grove greet <name>` — print a greeting.
 */

import { parseArgs } from "node:util";

export async function handleGreet(args: readonly string[]): Promise<void> {
  const { positionals } = parseArgs({
    args: args as string[],
    options: {},
    allowPositionals: true,
    strict: true,
  });

  if (positionals.length === 0) {
    console.error("Usage: grove greet <name>");
    process.exitCode = 1;
    return;
  }

  const name = positionals.join(" ");
  console.log(`Hello, ${name}! Welcome to the grove.`);
}
