/**
 * Orchestrator: ensure a `.grove/project-id` exists on `grove init`.
 *
 * Derivation flow (authoritative, spec #288):
 *   1. Existing local file → use.
 *   2. No git origin → generate, write local, skip registry.
 *   3. Registry miss → generate, write local, register.
 *   4. Registry hit → adopt (unify) or new, per flag / TTY prompt / non-TTY default.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  generateProjectId,
  PROJECT_ID_FILE,
  readProjectId,
  writeProjectId,
} from "../../core/project-id.js";
import {
  defaultRegistryPath,
  loadRegistry,
  lookupByOrigin,
  type RegistryEntry,
  updateRegistry,
  upsertEntry,
} from "../../core/project-registry.js";
import { detectOriginUrl, normalizeOriginUrl, sanitizeOriginForLog } from "./origin-url.js";

export interface EnsureOpts {
  readonly groveDir: string;
  readonly cwd: string;
  readonly unify?: boolean;
  readonly isTTY?: boolean;
  readonly registryPath?: string;
  readonly now?: () => Date;
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
}

export type EnsureSource = "local" | "registry" | "generated";

export interface EnsureResult {
  readonly id: string;
  readonly source: EnsureSource;
  readonly origin: string | null;
  readonly registered: boolean;
  readonly registryName: string | null;
}

function nameFromOrigin(normalized: string): string {
  const idx = normalized.indexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

export async function ensureProjectId(opts: EnsureOpts): Promise<EnsureResult> {
  const registryPath = opts.registryPath ?? defaultRegistryPath();
  const now = opts.now ?? (() => new Date());

  // 1. Existing local.
  const existing = readProjectId(opts.groveDir);
  if (existing != null) {
    return {
      id: existing,
      source: "local",
      origin: null,
      registered: false,
      registryName: null,
    };
  }

  // 2. Origin detection.
  const raw = detectOriginUrl(opts.cwd);
  const origin = raw ? normalizeOriginUrl(raw) : null;
  if (origin == null) {
    if (raw != null) {
      process.stderr.write(
        `grove init: unrecognized origin URL format: ${sanitizeOriginForLog(raw)} — registry skipped.\n`,
      );
    }
    const id = generateProjectId();
    writeProjectId(opts.groveDir, id);
    return {
      id,
      source: "generated",
      origin: null,
      registered: false,
      registryName: null,
    };
  }

  // 3. Registry lookup. The unlocked load is an optimistic fast-path —
  //    every commit (miss-register, hit-adopt) re-verifies under the lock.
  const reg = loadRegistry(registryPath);
  const hit = lookupByOrigin(reg, origin);
  if (hit == null) {
    return commitMissOrAdopt(opts, origin, registryPath, now);
  }

  // 4. Hit: decide adopt vs new.
  return resolveHit(opts, origin, registryPath, hit, now);
}

async function commitMissOrAdopt(
  opts: EnsureOpts,
  origin: string,
  registryPath: string,
  now: () => Date,
): Promise<EnsureResult> {
  // Miss path: write local-id INSIDE the registry lock, before saveRegistry
  // returns. If writeProjectId throws, modify throws, updateRegistry does
  // not save the new entry, and no orphan is published — so no rollback
  // race window exists for another process to read+adopt then have the
  // entry deleted from under it.
  const newEntry: RegistryEntry = {
    id: generateProjectId(),
    name: nameFromOrigin(origin),
    createdAt: now().toISOString(),
  };
  let concurrentHit: RegistryEntry | null = null;
  await updateRegistry(registryPath, (current) => {
    const found = lookupByOrigin(current, origin);
    if (found) {
      concurrentHit = found;
      return current;
    }
    writeProjectId(opts.groveDir, newEntry.id);
    return upsertEntry(current, origin, newEntry);
  });
  if (concurrentHit !== null) {
    // Another process registered first. Route through the same
    // decision path as a normal registry hit so distinct-by-default
    // still applies.
    return resolveHit(opts, origin, registryPath, concurrentHit, now);
  }
  return {
    id: newEntry.id,
    source: "generated",
    origin,
    registered: true,
    registryName: newEntry.name,
  };
}

async function resolveHit(
  opts: EnsureOpts,
  origin: string,
  registryPath: string,
  hit: RegistryEntry,
  now: () => Date,
): Promise<EnsureResult> {
  const decision = await decideAdopt(opts, hit);
  if (decision === "new") {
    const id = generateProjectId();
    writeProjectId(opts.groveDir, id);
    return {
      id,
      source: "generated",
      origin,
      registered: false,
      registryName: hit.name,
    };
  }
  // Adopt path. Take the lock, re-verify the entry still exists, and
  // commit local-id under the lock. If the entry has vanished (e.g. the
  // owner of an in-flight registration crashed), re-register fresh in
  // the same lock turn so the adopting clone always lands on a durable
  // registry entry.
  let resolved: RegistryEntry = hit;
  let registered = true;
  await updateRegistry(registryPath, (current) => {
    const found = lookupByOrigin(current, origin);
    if (found) {
      resolved = found;
      writeProjectId(opts.groveDir, found.id);
      return current;
    }
    const fresh: RegistryEntry = {
      id: generateProjectId(),
      name: nameFromOrigin(origin),
      createdAt: now().toISOString(),
    };
    writeProjectId(opts.groveDir, fresh.id);
    resolved = fresh;
    registered = true;
    return upsertEntry(current, origin, fresh);
  });
  return {
    id: resolved.id,
    source: "registry",
    origin,
    registered,
    registryName: resolved.name,
  };
}

async function decideAdopt(opts: EnsureOpts, hit: RegistryEntry): Promise<"adopt" | "new"> {
  if (opts.unify === true) return "adopt";
  if (opts.unify === false) return "new";
  if (!opts.isTTY) return "new";

  const stdout = opts.stdout ?? process.stdout;
  const stdin = opts.stdin ?? process.stdin;
  const prompt = `Matching project '${hit.name}' already registered (id ${hit.id}). Unify? [y/N] `;
  stdout.write(prompt);

  const answer = await readLine(stdin);
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "y" || trimmed === "yes") return "adopt";
  return "new";
}

/**
 * Roll back an `ensureProjectId` commit when later `grove init` steps
 * fail. Removes `.grove/project-id` (so the next retry takes the same
 * derivation path) and, when this clone freshly registered the origin,
 * deletes its registry entry — but only when the entry's id still
 * matches what we wrote, so a parallel adopter is not yanked.
 *
 * Best-effort: rollback errors are swallowed because the caller's
 * original error is what should propagate.
 */
export async function rollbackProjectIdentity(
  groveDir: string,
  ensureResult: EnsureResult,
  registryPath?: string,
): Promise<void> {
  if (ensureResult.source !== "local") {
    try {
      rmSync(join(groveDir, PROJECT_ID_FILE), { force: true });
    } catch {
      // ignore
    }
  }
  if (
    ensureResult.source === "generated" &&
    ensureResult.registered &&
    ensureResult.origin != null
  ) {
    const path = registryPath ?? defaultRegistryPath();
    try {
      await updateRegistry(path, (current) => {
        const found = lookupByOrigin(current, ensureResult.origin as string);
        if (found?.id !== ensureResult.id) return current;
        const next: Record<string, RegistryEntry> = { ...current.projects };
        delete next[ensureResult.origin as string];
        return { version: 1, projects: next };
      });
    } catch {
      // ignore
    }
  }
}

function readLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer | string) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        stream.off("data", onData);
        stream.off("end", onEnd);
        resolve(buf.slice(0, nl));
      }
    };
    const onEnd = () => {
      stream.off("data", onData);
      resolve(buf);
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
  });
}
