/**
 * `grove version` command — print the grove version from package.json.
 *
 * Usage:
 *   grove version
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Read the version string from the root package.json. */
function getVersion(): string {
  const pkgPath = join(import.meta.dir, "../../../package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
  return pkg.version ?? "unknown";
}

/** Handle the `grove version` CLI command. */
export function handleVersion(): void {
  console.log(`grove ${getVersion()}`);
}
