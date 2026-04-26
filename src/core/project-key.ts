/**
 * Namespace key management — bearer token generation and credential I/O.
 *
 * Generates opaque API keys scoped to a `{project-uuid}/{worktree-name}` namespace.
 * - `.grove/api-key` — client credential (one key per clone, 0o600)
 * - `.grove/server-keys.yaml` — server registry mapping keys to namespaces (0o600)
 *
 * Both files are covered by the root `.gitignore` (`.grove/` is excluded).
 */

import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const CLIENT_KEY_FILE = "api-key";
export const SERVER_KEYS_FILE = "server-keys.yaml";

/** Generate a unique opaque bearer token prefixed with `grv_`. */
export function generateApiKey(): string {
  return `grv_${randomBytes(32).toString("hex")}`;
}

/**
 * Detect the current git worktree name (branch name or commit hash fallback).
 * Returns "main" if git is unavailable or in a detached HEAD with no branch.
 */
export async function detectWorktreeName(): Promise<string> {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (branch && branch !== "HEAD") {
      // Sanitize: replace chars invalid in a URL path segment
      return branch.replace(/[^a-zA-Z0-9._-]/g, "-");
    }
    // Detached HEAD — use short commit hash
    const sha = execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return sha || "main";
  } catch {
    return "main";
  }
}

/** Write the client credential to `<groveDir>/api-key` (overwrites). */
export function writeClientKey(groveDir: string, key: string): void {
  const target = join(groveDir, CLIENT_KEY_FILE);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${key}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, target);
}

interface ServerKeysFile {
  version: 1;
  keys: Record<string, { namespace: string; createdAt: string }>;
}

/** Append a key → namespace entry to `<groveDir>/server-keys.yaml`. */
export function appendServerKey(
  groveDir: string,
  key: string,
  namespace: string,
): void {
  const filePath = join(groveDir, SERVER_KEYS_FILE);
  let existing: ServerKeysFile = { version: 1, keys: {} };
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = parseYaml(raw) as ServerKeysFile;
    if (parsed?.version === 1 && parsed.keys) {
      existing = parsed;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  existing.keys[key] = { namespace, createdAt: new Date().toISOString() };
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, stringifyYaml(existing), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, filePath);
}
