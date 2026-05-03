import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "grove";
const FALLBACK_PACKAGE_VERSION = "unknown";

interface PackageJson {
  readonly name?: string;
  readonly version?: string;
}

export function readGrovePackageVersion(startFileUrl: string = import.meta.url): string {
  const packageJsonPath = findGrovePackageJson(startFileUrl);
  if (packageJsonPath === undefined) return FALLBACK_PACKAGE_VERSION;

  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
    return typeof parsed.version === "string" ? parsed.version : FALLBACK_PACKAGE_VERSION;
  } catch {
    return FALLBACK_PACKAGE_VERSION;
  }
}

function findGrovePackageJson(startFileUrl: string): string | undefined {
  let cursor = dirname(fileURLToPath(startFileUrl));

  while (true) {
    const packageJsonPath = join(cursor, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
        if (parsed.name === PACKAGE_NAME) return packageJsonPath;
      } catch {
        // Keep walking so a malformed nested package cannot hide the project root.
      }
    }

    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}
