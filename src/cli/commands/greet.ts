/**
 * `grove greet <name>` — print a greeting.
 */

import { parseArgs } from "node:util";

import { UsageError } from "../errors.js";

export async function handleGreet(args: readonly string[]): Promise<void> {
  const { positionals } = parseArgs({
    args: args as string[],
    options: {},
    allowPositionals: true,
    strict: true,
  });

  const name = positionals[0];
  if (!name) {
    throw new UsageError("usage: grove greet <name>");
  }

  console.log(`hello ${name}`);
}
