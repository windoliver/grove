/**
 * `grove version` command — print the grove version from package.json.
 *
 * Usage:
 *   grove version
 */

import { readGrovePackageVersion } from "../utils/package-version.js";

/** Read the version string from the root package.json. */
function getVersion(): string {
  return readGrovePackageVersion();
}

/** Handle the `grove version` CLI command. */
export function handleVersion(): void {
  console.log(`grove ${getVersion()}`);
}
