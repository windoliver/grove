/**
 * Orchestrator: ensure a `.grove/project-id` exists on `grove init`.
 *
 * Derivation flow (authoritative, spec #288):
 *   1. Existing local file → use.
 *   2. No git origin → generate, write local, skip registry.
 *   3. Registry miss → generate, write local, register.
 *   4. Registry hit → adopt (unify) or new, per flag / TTY prompt / non-TTY default.
 */

import { generateProjectId, readProjectId, writeProjectId } from "../../core/project-id.js";
import {
  defaultRegistryPath,
  loadRegistry,
  lookupByOrigin,
  type RegistryEntry,
  updateRegistry,
  upsertEntry,
} from "../../core/project-registry.js";
import { detectOriginUrl, normalizeOriginUrl } from "./origin-url.js";

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
        `grove init: unrecognized origin URL format: ${raw} — registry skipped.\n`,
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

  // 3. Registry lookup.
  const reg = loadRegistry(registryPath);
  const hit = lookupByOrigin(reg, origin);
  if (hit == null) {
    // Atomic load → check → upsert → save inside a filesystem lock.
    // updateRegistry reloads inside the lock so a parallel `grove init`
    // for a different origin can't be silently overwritten.
    //
    // Save registry BEFORE writing the local id so a registry failure
    // doesn't leave behind a `.grove/project-id` that short-circuits all
    // future retries (which would lose registry correlation).
    const id = generateProjectId();
    const name = nameFromOrigin(origin);
    const createdAt = now().toISOString();
    let resolvedEntry: RegistryEntry = { id, name, createdAt };
    await updateRegistry(registryPath, (current) => {
      const concurrentHit = lookupByOrigin(current, origin);
      if (concurrentHit) {
        // Another process registered the same origin between our read
        // and our lock acquisition. Adopt their entry rather than
        // overwriting it.
        resolvedEntry = concurrentHit;
        return current;
      }
      return upsertEntry(current, origin, resolvedEntry);
    });
    writeProjectId(opts.groveDir, resolvedEntry.id);
    return {
      id: resolvedEntry.id,
      source: "generated",
      origin,
      registered: true,
      registryName: resolvedEntry.name,
    };
  }

  // 4. Hit: decide adopt vs new.
  const decision = await decideAdopt(opts, hit);
  if (decision === "adopt") {
    writeProjectId(opts.groveDir, hit.id);
    return {
      id: hit.id,
      source: "registry",
      origin,
      registered: true,
      registryName: hit.name,
    };
  }
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

async function decideAdopt(opts: EnsureOpts, hit: RegistryEntry): Promise<"adopt" | "new"> {
  if (opts.unify === true) return "adopt";
  if (opts.unify === false) return "new";
  if (!opts.isTTY) return "new";

  const stdout = opts.stdout ?? process.stdout;
  const stdin = opts.stdin ?? process.stdin;
  const prompt = `Matching project '${hit.name}' already registered (id ${hit.id}). Unify? [Y/n] `;
  stdout.write(prompt);

  const answer = await readLine(stdin);
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "" || trimmed === "y" || trimmed === "yes") return "adopt";
  return "new";
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
