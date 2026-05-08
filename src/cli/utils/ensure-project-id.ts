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

  // 1. Existing local — read-only. We do NOT touch the registry here:
  //    publishing an id whose owning clone hasn't completed init yet
  //    would let `--unify` adopters land on incomplete clones. Registry
  //    reconciliation is deferred to `finalizeProjectIdentity`, which
  //    `executeInit` calls only after every fallible step has succeeded.
  //    The kill-between-writes recovery (local present, registry empty)
  //    is handled there too.
  const existing = readProjectId(opts.groveDir);
  if (existing != null) {
    const raw = detectOriginUrl(opts.cwd);
    const origin = raw ? normalizeOriginUrl(raw) : null;
    if (origin != null) {
      const reg = loadRegistry(registryPath);
      const found = lookupByOrigin(reg, origin);
      return {
        id: existing,
        source: "local",
        origin,
        registered: found?.id === existing,
        registryName: found?.name ?? null,
      };
    }
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
  _registryPath: string,
  _now: () => Date,
): Promise<EnsureResult> {
  // Miss path: generate a local id and write the local file. We do NOT
  // write to the registry here — that write is deferred to
  // `finalizeProjectIdentity`, which the caller invokes only after the
  // rest of init has succeeded. Publishing in two phases prevents a
  // failed init from leaving an incomplete clone exposed to future
  // `--unify` adopters.
  const id = generateProjectId();
  writeProjectId(opts.groveDir, id);
  return {
    id,
    source: "generated",
    origin,
    registered: false,
    registryName: null,
  };
}

async function resolveHit(
  opts: EnsureOpts,
  origin: string,
  registryPath: string,
  hit: RegistryEntry,
  _now: () => Date,
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
  // Adopt path. The user (via `--unify` or the prompt) approved adoption
  // of a specific id+name shown in the optimistic `hit`. Re-verify under
  // the registry lock that the same entry is still present. If it
  // changed or vanished while the prompt was open, abort with a clear
  // error rather than silently binding to a different id.
  const confirmed = await readEntryUnderLock(registryPath, origin, hit);
  if (confirmed === null) {
    throw new Error(
      `grove init: registry entry for origin '${origin}' changed during the unify prompt; re-run grove init to retry.`,
    );
  }
  writeProjectId(opts.groveDir, confirmed.id);
  return {
    id: confirmed.id,
    source: "registry",
    origin,
    registered: true,
    registryName: confirmed.name,
  };
}

async function readEntryUnderLock(
  registryPath: string,
  origin: string,
  expected: RegistryEntry,
): Promise<RegistryEntry | null> {
  let captured: RegistryEntry | null = null;
  await updateRegistry(registryPath, (current) => {
    const found = lookupByOrigin(current, origin);
    if (found?.id === expected.id && found.name === expected.name) {
      captured = found;
    }
    return current;
  });
  return captured;
}

/**
 * Publish the project identity to the registry once `grove init` has
 * reached a durable completion point. Idempotent and lock-safe.
 *
 * Behaviors:
 * - No origin → no-op (nothing to register).
 * - Registry has no entry for the origin → insert ours. Covers both
 *   first-init publication and the kill-between-writes recovery path
 *   (local id present, registry empty).
 * - Registry has an entry whose id matches ours → no-op (already correct).
 * - Registry has an entry whose id differs → leave it intact. Another
 *   clone owns the origin; this clone stays unregistered and reports
 *   `registered: false`.
 *
 * Returns an `EnsureResult` with up-to-date `registered`/`registryName`
 * fields.
 */
export async function finalizeProjectIdentity(
  ensureResult: EnsureResult,
  opts: { registryPath?: string; now?: () => Date } = {},
): Promise<EnsureResult> {
  if (ensureResult.origin == null) return ensureResult;
  const path = opts.registryPath ?? defaultRegistryPath();
  const now = opts.now ?? (() => new Date());
  let registered = ensureResult.registered;
  let registryName: string | null = ensureResult.registryName;
  let staleAdopt = false;
  await updateRegistry(path, (current) => {
    const origin = ensureResult.origin as string;
    const found = lookupByOrigin(current, origin);
    if (found != null) {
      // For an adopted hit (`source: 'registry'`), the local file already
      // contains an id whose owning registry entry the user explicitly
      // approved. If that entry has since changed or vanished, the adopt
      // invariant is broken — fail loudly rather than silently flipping
      // `registered: false` and shipping with an id no future `--unify`
      // clone will follow.
      if (
        ensureResult.source === "registry" &&
        (found.id !== ensureResult.id || found.name !== ensureResult.registryName)
      ) {
        staleAdopt = true;
        return current;
      }
      registered = found.id === ensureResult.id;
      registryName = found.name;
      return current;
    }
    if (ensureResult.source === "registry") {
      staleAdopt = true;
      return current;
    }
    const newEntry: RegistryEntry = {
      id: ensureResult.id,
      name: nameFromOrigin(origin),
      createdAt: now().toISOString(),
    };
    registered = true;
    registryName = newEntry.name;
    return upsertEntry(current, origin, newEntry);
  });
  if (staleAdopt) {
    throw new Error(
      `grove init: registry entry for origin '${ensureResult.origin}' changed between adopt and finalize; re-run grove init to retry.`,
    );
  }
  return { ...ensureResult, registered, registryName };
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
 * fail.
 *
 * Two invariants drive the policy:
 *
 * - Never delete the registry entry. Once published, it may already
 *   have been adopted by a parallel `grove init --unify` whose
 *   lock-and-commit completed before this caller failed; deleting it
 *   would leave the adopter with a local id no future clone can
 *   discover, splitting project identity.
 * - Never delete `.grove/project-id` when it matches a published
 *   registry entry (`source: "registry"` or `source: "generated"` with
 *   `registered: true`). Removing it would let a retry generate a fresh
 *   unregistered id, leaving the registry orphaned and future `--unify`
 *   clones to adopt the failed attempt's id instead of the completed
 *   clone. Keeping local + registry in sync means a retry resumes
 *   cleanly via the `source: local` short-circuit.
 *
 * The only case where we DO remove the local file is `source:
 * "generated"` with `registered: false` — the id was never published,
 * so a clean retry should be free to mint a new one (no-origin clones
 * and explicit-distinct chooser).
 *
 * Best-effort: rollback errors are swallowed because the caller's
 * original error is what should propagate.
 */
export async function rollbackProjectIdentity(
  groveDir: string,
  ensureResult: EnsureResult,
  _registryPath?: string,
): Promise<void> {
  if (ensureResult.source === "generated" && !ensureResult.registered) {
    try {
      rmSync(join(groveDir, PROJECT_ID_FILE), { force: true });
    } catch {
      // best-effort
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
