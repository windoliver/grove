/**
 * Namespace key management — bearer token generation and credential I/O.
 *
 * Generates opaque API keys scoped to a `{project-uuid}/{worktree-name}` namespace.
 * - `.grove/api-key` — client credential (one key per clone, 0o600)
 * - `.grove/server-keys.yaml` — server registry mapping keys to namespaces (0o600)
 *
 * Both files are covered by the root `.gitignore` (`.grove/` is excluded).
 */

import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const CLIENT_KEY_FILE = "api-key";
export const SERVER_KEYS_FILE = "server-keys.yaml";
export const NAMESPACE_FILE = "namespace";

/** Generate a unique opaque bearer token prefixed with `grv_`. */
export function generateApiKey(): string {
  return `grv_${randomBytes(32).toString("hex")}`;
}

/**
 * Detect a stable worktree name from the git worktree directory path.
 *
 * Uses the basename of the worktree's top-level directory — stable across branch
 * renames and unique for each worktree path. Two detached worktrees at the same
 * commit will get distinct names as long as they live in different directories.
 *
 * Falls back to branch name, then short commit hash, then "main".
 */
export async function detectWorktreeName(): Promise<string> {
  try {
    // Primary: stable identity from the worktree directory name.
    const toplevel = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (toplevel) {
      const name = basename(toplevel).replace(/[^a-zA-Z0-9._-]/g, "-");
      if (name && name !== ".") return name;
    }
  } catch {
    /* fall through */
  }

  try {
    // Fallback: branch name (changes on checkout, but better than a commit hash).
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (branch && branch !== "HEAD") {
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

/** Read the client credential from `<groveDir>/api-key`. Returns undefined if absent. */
export function readClientKey(groveDir: string): string | undefined {
  const filePath = join(groveDir, CLIENT_KEY_FILE);
  try {
    return readFileSync(filePath, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
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

/**
 * Persist the resolved namespace to `<groveDir>/namespace`.
 * Written at `grove init` so serve.ts can read a stable identity on startup
 * regardless of the current branch name.
 */
export function writeNamespace(groveDir: string, namespace: string): void {
  const target = join(groveDir, NAMESPACE_FILE);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${namespace}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, target);
}

/** Read the persisted namespace from `<groveDir>/namespace`. Returns undefined if absent. */
export function readNamespace(groveDir: string): string | undefined {
  const filePath = join(groveDir, NAMESPACE_FILE);
  try {
    const ns = readFileSync(filePath, "utf8").trim();
    return ns || undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Strict-parse `<groveDir>/server-keys.yaml`.
 *
 * Returns `null` if the file does not exist. Throws on any other failure
 * mode (unparseable YAML, non-object root, unsupported version, missing
 * `keys` map). Callers must NEVER fall back to an empty registry on
 * failure — doing so would silently overwrite forward-version files that
 * may carry credentials this code base does not understand.
 */
export function parseServerKeys(groveDir: string): ServerKeysFile | null {
  const filePath = join(groveDir, SERVER_KEYS_FILE);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`server-keys.yaml is not valid YAML: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("server-keys.yaml is not a YAML object");
  }
  const candidate = parsed as { version?: unknown; keys?: unknown };
  if (candidate.version !== 1) {
    throw new Error(
      `server-keys.yaml has unsupported version=${String(candidate.version)}; refusing to mutate`,
    );
  }
  if (typeof candidate.keys !== "object" || candidate.keys === null) {
    throw new Error("server-keys.yaml is missing the 'keys' map; refusing to mutate");
  }
  return { version: 1, keys: candidate.keys as ServerKeysFile["keys"] };
}

/**
 * Append a key → namespace entry to `<groveDir>/server-keys.yaml`.
 *
 * Strict: throws if an existing file is not a recognized version-1
 * registry (preserves forward-version data; never silently clobbers).
 */
export function appendServerKey(groveDir: string, key: string, namespace: string): void {
  const filePath = join(groveDir, SERVER_KEYS_FILE);
  const existing = parseServerKeys(groveDir) ?? { version: 1 as const, keys: {} };
  existing.keys[key] = { namespace, createdAt: new Date().toISOString() };
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, stringifyYaml(existing), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, filePath);
}

export interface RemoveServerKeyResult {
  /** True iff a parseable version-1 registry was found on disk. */
  readonly registryFound: boolean;
  /** True iff the key was present and has now been removed. */
  readonly removed: boolean;
  /** Remaining key count after removal. 0 when registry absent. */
  readonly remaining: number;
}

/**
 * Remove a single key from `<groveDir>/server-keys.yaml`.
 *
 * Strict parse: throws if the file exists but is not a recognized
 * version-1 registry (so we never silently treat a forward-version file as
 * empty and let callers delete it). The returned result distinguishes the
 * three cases: registry absent, key already absent, key removed.
 */
export function removeServerKey(groveDir: string, key: string): RemoveServerKeyResult {
  const registry = parseServerKeys(groveDir);
  if (registry === null) {
    return { registryFound: false, removed: false, remaining: 0 };
  }
  if (!(key in registry.keys)) {
    return { registryFound: true, removed: false, remaining: Object.keys(registry.keys).length };
  }
  delete registry.keys[key];
  const filePath = join(groveDir, SERVER_KEYS_FILE);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, stringifyYaml(registry), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, filePath);
  return { registryFound: true, removed: true, remaining: Object.keys(registry.keys).length };
}
