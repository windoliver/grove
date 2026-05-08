import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { hash } from "blake3";

import type { SkillCatalogPolicy, SkillCatalogTrustedKey } from "../core/config.js";
import {
  parseSkillCatalogIndex,
  parseSkillCatalogSignature,
  type SkillCatalogIndex,
  type SkillCatalogSignature,
  SkillCatalogTrustError,
  SkillCatalogUnavailableError,
  unpackSkillBundle,
  verifyBundleHash,
  verifyCatalogSignature,
} from "../core/skill-catalog.js";
import type { NexusClient } from "./client.js";
import {
  skillCatalogBundlePath,
  skillCatalogIndexPath,
  skillCatalogSignaturePath,
} from "./vfs-paths.js";

export interface SkillResolutionWarning {
  readonly skillName: string;
  readonly attemptedSource: string;
  readonly fallbackSource?: string | undefined;
  readonly reason: string;
}

export interface ResolvedSkillCatalogRoot {
  readonly root: string;
  readonly source: "nexus" | "cache" | "local";
  readonly warnings: readonly SkillResolutionWarning[];
}

export interface ResolveNexusSkillCatalogRootOptions {
  readonly client: NexusClient;
  readonly zoneId: string;
  readonly cacheRoot: string;
  readonly skills: readonly string[];
  readonly policy: SkillCatalogPolicy;
  readonly trustedKeys: readonly SkillCatalogTrustedKey[];
  readonly localFallbackRoots: readonly string[];
}

interface SkillCatalogBytes {
  readonly indexBytes: Uint8Array;
  readonly signatureBytes: Uint8Array;
}

interface VerifiedSkillCatalog extends SkillCatalogBytes {
  readonly index: SkillCatalogIndex;
  readonly signature: SkillCatalogSignature;
}

interface ResolutionCandidate {
  readonly root: string;
  readonly source: "cache" | "local";
}

interface LocalSkillSource {
  readonly skillName: string;
  readonly sourceDir: string;
}

interface SkillBundleMarker {
  readonly schemaVersion: 1;
  readonly skillName: string;
  readonly version: string;
  readonly bundleHash: string;
}

const COMPLETION_MARKER = ".grove-skill-bundle.json";
const decoder = new TextDecoder();
const segmentEncoder = new TextEncoder();
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;

function safePathSegment(value: string): string {
  const bytes = segmentEncoder.encode(value);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cacheSkillDir(
  cacheRoot: string,
  skillName: string,
  version: string,
  bundleHash: string,
): string {
  return join(
    cacheRoot,
    "unpacked",
    safePathSegment(skillName),
    safePathSegment(version),
    safePathSegment(bundleHash),
  );
}

function localBundlePath(cacheRoot: string, bundleHash: string): string {
  return join(cacheRoot, "bundles", `${safePathSegment(bundleHash)}.zip`);
}

function completionMarkerPath(skillDir: string): string {
  return join(skillDir, COMPLETION_MARKER);
}

function resolvedRoot(cacheRoot: string, skills: readonly string[], suffix: string): string {
  const key = JSON.stringify({ skills, suffix });
  const digest = hash(segmentEncoder.encode(key)).toString("hex");
  return join(cacheRoot, "resolved", `skills-${digest}`);
}

function catalogCacheCurrentDir(cacheRoot: string): string {
  return join(cacheRoot, "catalog", "current");
}

function catalogCacheIndexPath(cacheRoot: string): string {
  return join(catalogCacheCurrentDir(cacheRoot), "index.json");
}

function catalogCacheSignaturePath(cacheRoot: string): string {
  return join(catalogCacheCurrentDir(cacheRoot), "index.sig");
}

function redactUrlMatch(raw: string): string {
  let candidate = raw;
  let suffix = "";
  while (candidate.length > 0) {
    try {
      const url = new URL(candidate);
      const needsRedaction =
        url.username.length > 0 ||
        url.password.length > 0 ||
        (url.pathname.length > 0 && url.pathname !== "/") ||
        url.search.length > 0 ||
        url.hash.length > 0;
      if (!needsRedaction) return `${url.protocol}//${url.host}${suffix}`;
      return `${url.protocol}//${url.host}/[redacted]${suffix}`;
    } catch {
      suffix = `${candidate[candidate.length - 1]}${suffix}`;
      candidate = candidate.slice(0, -1);
    }
  }
  return `[redacted-url]${suffix}`;
}

function redactSensitiveText(text: string): string {
  return text.replace(URL_PATTERN, redactUrlMatch);
}

function reasonFromError(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitiveText(error.message);
  }
  return redactSensitiveText(String(error));
}

function safeSurfaceError(error: unknown): Error {
  const reason = reasonFromError(error);
  if (error instanceof SkillCatalogTrustError) {
    return new SkillCatalogTrustError(reason);
  }
  return new SkillCatalogUnavailableError(reason);
}

function fallbackWarnings(
  skills: readonly string[],
  fallbackSource: "cache" | "local" | undefined,
  error: unknown,
): readonly SkillResolutionWarning[] {
  const reason = reasonFromError(error);
  return skills.map((skillName) => ({
    skillName,
    attemptedSource: "nexus",
    fallbackSource,
    reason,
  }));
}

function validateRequestedSkills(skills: readonly string[]): void {
  for (const skillName of skills) {
    if (
      skillName.length === 0 ||
      skillName === "." ||
      skillName === ".." ||
      skillName.includes("/") ||
      skillName.includes("\\") ||
      skillName.includes("\0")
    ) {
      throw new SkillCatalogUnavailableError(
        `Unsafe skill name in skill catalog request: ${skillName}`,
      );
    }
  }
}

function requireTrustedKeys(trustedKeys: readonly SkillCatalogTrustedKey[]): void {
  if (trustedKeys.length === 0) {
    throw new SkillCatalogTrustError("No trusted keys configured for skill catalog verification");
  }
}

function parseAndVerifyCatalog(opts: {
  readonly indexBytes: Uint8Array;
  readonly signatureBytes: Uint8Array;
  readonly trustedKeys: readonly SkillCatalogTrustedKey[];
}): VerifiedSkillCatalog {
  const index = parseSkillCatalogIndex(decoder.decode(opts.indexBytes));
  const signature = parseSkillCatalogSignature(decoder.decode(opts.signatureBytes));
  verifyCatalogSignature({
    indexBytes: opts.indexBytes,
    signature,
    trustedKeys: opts.trustedKeys,
  });
  return {
    indexBytes: opts.indexBytes,
    signatureBytes: opts.signatureBytes,
    index,
    signature,
  };
}

function skillEntry(
  index: SkillCatalogIndex,
  skillName: string,
): SkillCatalogIndex["skills"][string] {
  const entry = index.skills[skillName];
  if (entry === undefined) {
    throw new SkillCatalogUnavailableError(
      `Skill is missing from Nexus skill catalog: ${skillName}`,
    );
  }
  return entry;
}

function catalogSuffix(index: SkillCatalogIndex, skills: readonly string[]): string {
  return skills
    .map((skillName) => {
      const entry = skillEntry(index, skillName);
      return `${entry.version}-${entry.bundleHash}`;
    })
    .join("-");
}

async function copySkillRoot(source: string, target: string): Promise<void> {
  await cp(source, target, { recursive: true, force: true });
}

async function writeAtomicFile(path: string, content: Uint8Array | string): Promise<void> {
  const parentDir = dirname(path);
  await mkdir(parentDir, { recursive: true });
  const tempDir = await mkdtemp(join(parentDir, ".tmp-"));
  const tempPath = join(tempDir, basename(path));
  try {
    await writeFile(tempPath, content);
    await rename(tempPath, path);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function expectedMarker(opts: {
  readonly skillName: string;
  readonly version: string;
  readonly bundleHash: string;
}): SkillBundleMarker {
  return {
    schemaVersion: 1,
    skillName: opts.skillName,
    version: opts.version,
    bundleHash: opts.bundleHash,
  };
}

async function writeCompletionMarker(skillDir: string, marker: SkillBundleMarker): Promise<void> {
  await writeAtomicFile(completionMarkerPath(skillDir), `${JSON.stringify(marker, null, 2)}\n`);
}

async function readVerifiedLocalBundle(
  cacheRoot: string,
  bundleHash: string,
): Promise<Uint8Array | undefined> {
  try {
    const bundleBytes = await readFile(localBundlePath(cacheRoot, bundleHash));
    verifyBundleHash(bundleBytes, bundleHash);
    return bundleBytes;
  } catch {
    return undefined;
  }
}

async function persistVerifiedBundle(
  cacheRoot: string,
  bundleHash: string,
  bundleBytes: Uint8Array,
): Promise<void> {
  verifyBundleHash(bundleBytes, bundleHash);
  await writeAtomicFile(localBundlePath(cacheRoot, bundleHash), bundleBytes);
}

async function materializeCachedSkill(opts: {
  readonly bundleBytes: Uint8Array;
  readonly skillDir: string;
  readonly marker: SkillBundleMarker;
}): Promise<void> {
  await unpackSkillBundle(opts.bundleBytes, opts.skillDir);
  await writeCompletionMarker(opts.skillDir, opts.marker);
}

async function replaceDirectoryWithPreparedTemp(root: string, tempRoot: string): Promise<void> {
  const parentDir = dirname(root);
  let installed = false;
  let backupParent: string | undefined;
  let movedExistingRoot = false;
  try {
    if (existsSync(root)) {
      backupParent = await mkdtemp(join(parentDir, `.${basename(root)}.backup-`));
      await rename(root, join(backupParent, "old"));
      movedExistingRoot = true;
    }
    await rename(tempRoot, root);
    installed = true;
    if (backupParent !== undefined) {
      await rm(backupParent, { recursive: true, force: true });
    }
  } catch (error) {
    if (movedExistingRoot && backupParent !== undefined && !existsSync(root)) {
      try {
        await rename(join(backupParent, "old"), root);
      } catch {
        // Preserve the original failure if rollback also fails.
      }
    }
    throw error;
  } finally {
    if (!installed) {
      await rm(tempRoot, { recursive: true, force: true });
    }
    if (backupParent !== undefined) {
      await rm(backupParent, { recursive: true, force: true });
    }
  }
}

async function materializeResolvedRoot(
  root: string,
  sources: readonly LocalSkillSource[],
): Promise<void> {
  const parentDir = dirname(root);
  await mkdir(parentDir, { recursive: true });
  const tempRoot = await mkdtemp(join(parentDir, `.${basename(root)}.tmp-`));
  try {
    for (const source of sources) {
      await copySkillRoot(source.sourceDir, join(tempRoot, source.skillName));
    }
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
  await replaceDirectoryWithPreparedTemp(root, tempRoot);
}

async function publishCatalogCache(cacheRoot: string, catalog: SkillCatalogBytes): Promise<void> {
  const currentDir = catalogCacheCurrentDir(cacheRoot);
  const catalogDir = dirname(currentDir);
  await mkdir(catalogDir, { recursive: true });
  const tempRoot = await mkdtemp(join(catalogDir, ".current.tmp-"));
  try {
    await writeFile(join(tempRoot, "index.json"), catalog.indexBytes);
    await writeFile(join(tempRoot, "index.sig"), catalog.signatureBytes);
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
  await replaceDirectoryWithPreparedTemp(currentDir, tempRoot);
}

async function writeLegacyCatalogCache(
  cacheRoot: string,
  catalog: SkillCatalogBytes,
): Promise<void> {
  await writeAtomicFile(join(cacheRoot, "index.json"), catalog.indexBytes);
  await writeAtomicFile(join(cacheRoot, "index.sig"), catalog.signatureBytes);
}

async function readPublishedCatalogCache(
  cacheRoot: string,
): Promise<SkillCatalogBytes | undefined> {
  const indexPath = catalogCacheIndexPath(cacheRoot);
  const signaturePath = catalogCacheSignaturePath(cacheRoot);
  if (!existsSync(indexPath) || !existsSync(signaturePath)) {
    return undefined;
  }
  try {
    const [indexBytes, signatureBytes] = await Promise.all([
      readFile(indexPath),
      readFile(signaturePath),
    ]);
    return { indexBytes, signatureBytes };
  } catch {
    return undefined;
  }
}

async function readNexusCatalog(
  opts: ResolveNexusSkillCatalogRootOptions,
): Promise<SkillCatalogBytes> {
  requireTrustedKeys(opts.trustedKeys);

  const [indexBytes, signatureBytes] = await Promise.all([
    opts.client.read(skillCatalogIndexPath(opts.zoneId)),
    opts.client.read(skillCatalogSignaturePath(opts.zoneId)),
  ]);
  if (indexBytes === undefined || signatureBytes === undefined) {
    throw new SkillCatalogUnavailableError("Nexus skill catalog index or signature is unavailable");
  }
  return { indexBytes, signatureBytes };
}

async function ensureNexusSkillCached(opts: {
  readonly client: NexusClient;
  readonly zoneId: string;
  readonly cacheRoot: string;
  readonly skillName: string;
  readonly index: SkillCatalogIndex;
}): Promise<string> {
  const entry = skillEntry(opts.index, opts.skillName);
  const skillDir = cacheSkillDir(opts.cacheRoot, opts.skillName, entry.version, entry.bundleHash);
  const marker = expectedMarker({
    skillName: opts.skillName,
    version: entry.version,
    bundleHash: entry.bundleHash,
  });
  const localBundleBytes = await readVerifiedLocalBundle(opts.cacheRoot, entry.bundleHash);
  if (localBundleBytes !== undefined) {
    await materializeCachedSkill({ bundleBytes: localBundleBytes, skillDir, marker });
    return skillDir;
  }

  const bundleBytes = await opts.client.read(skillCatalogBundlePath(opts.zoneId, entry.bundleHash));
  if (bundleBytes === undefined) {
    throw new SkillCatalogUnavailableError(
      `Nexus skill bundle is unavailable for ${opts.skillName}: ${entry.bundleHash}`,
    );
  }
  verifyBundleHash(bundleBytes, entry.bundleHash);
  await persistVerifiedBundle(opts.cacheRoot, entry.bundleHash, bundleBytes);
  await materializeCachedSkill({ bundleBytes, skillDir, marker });
  return skillDir;
}

async function resolveFromNexus(
  opts: ResolveNexusSkillCatalogRootOptions,
): Promise<ResolvedSkillCatalogRoot> {
  validateRequestedSkills(opts.skills);
  const catalogBytes = await readNexusCatalog(opts);
  const catalog = parseAndVerifyCatalog({
    ...catalogBytes,
    trustedKeys: opts.trustedKeys,
  });
  const targetRoot = resolvedRoot(
    opts.cacheRoot,
    opts.skills,
    catalogSuffix(catalog.index, opts.skills),
  );

  await mkdir(opts.cacheRoot, { recursive: true });
  const cachedSkillDirs: LocalSkillSource[] = [];
  for (const skillName of opts.skills) {
    const sourceDir = await ensureNexusSkillCached({
      client: opts.client,
      zoneId: opts.zoneId,
      cacheRoot: opts.cacheRoot,
      skillName,
      index: catalog.index,
    });
    cachedSkillDirs.push({ skillName, sourceDir });
  }

  await publishCatalogCache(opts.cacheRoot, catalog);
  await writeLegacyCatalogCache(opts.cacheRoot, catalog);
  await materializeResolvedRoot(targetRoot, cachedSkillDirs);

  return { root: targetRoot, source: "nexus", warnings: [] };
}

async function tryVerifiedCache(
  opts: ResolveNexusSkillCatalogRootOptions,
): Promise<ResolutionCandidate | undefined> {
  validateRequestedSkills(opts.skills);
  const cachedCatalogBytes = await readPublishedCatalogCache(opts.cacheRoot);
  if (cachedCatalogBytes === undefined) {
    return undefined;
  }

  try {
    const catalog = parseAndVerifyCatalog({
      ...cachedCatalogBytes,
      trustedKeys: opts.trustedKeys,
    });
    const sources: LocalSkillSource[] = [];
    for (const skillName of opts.skills) {
      const entry = skillEntry(catalog.index, skillName);
      const sourceDir = cacheSkillDir(opts.cacheRoot, skillName, entry.version, entry.bundleHash);
      const marker = expectedMarker({
        skillName,
        version: entry.version,
        bundleHash: entry.bundleHash,
      });
      const bundleBytes = await readVerifiedLocalBundle(opts.cacheRoot, entry.bundleHash);
      if (bundleBytes === undefined) {
        return undefined;
      }
      await materializeCachedSkill({ bundleBytes, skillDir: sourceDir, marker });
      sources.push({ skillName, sourceDir });
    }

    const targetRoot = resolvedRoot(
      opts.cacheRoot,
      opts.skills,
      catalogSuffix(catalog.index, opts.skills),
    );
    await materializeResolvedRoot(targetRoot, sources);
    return { root: targetRoot, source: "cache" };
  } catch {
    return undefined;
  }
}

async function tryLocalFallback(
  opts: ResolveNexusSkillCatalogRootOptions,
): Promise<ResolutionCandidate | undefined> {
  validateRequestedSkills(opts.skills);
  const sources: LocalSkillSource[] = [];
  for (const skillName of opts.skills) {
    let sourceDir: string | undefined;
    for (const fallbackRoot of opts.localFallbackRoots) {
      const candidate = join(fallbackRoot, skillName);
      if (existsSync(join(candidate, "SKILL.md"))) {
        sourceDir = candidate;
        break;
      }
    }
    if (sourceDir === undefined) {
      return undefined;
    }
    sources.push({ skillName, sourceDir });
  }

  const targetRoot = resolvedRoot(opts.cacheRoot, opts.skills, "local");
  await materializeResolvedRoot(targetRoot, sources);
  return { root: targetRoot, source: "local" };
}

/**
 * Test/fixture helper that writes raw signed skill catalog artifacts directly
 * to Nexus VFS paths. Production code should publish catalogs through the
 * catalog generation/signing flow instead.
 */
export async function writeSkillCatalogToNexusForTest(opts: {
  readonly client: NexusClient;
  readonly zoneId: string;
  readonly indexBytes: Uint8Array;
  readonly signatureBytes: Uint8Array;
  readonly bundleHash: string;
  readonly bundleBytes: Uint8Array;
}): Promise<void> {
  await opts.client.write(skillCatalogIndexPath(opts.zoneId), opts.indexBytes);
  await opts.client.write(skillCatalogSignaturePath(opts.zoneId), opts.signatureBytes);
  await opts.client.write(skillCatalogBundlePath(opts.zoneId, opts.bundleHash), opts.bundleBytes);
}

export async function resolveNexusSkillCatalogRoot(
  opts: ResolveNexusSkillCatalogRootOptions,
): Promise<ResolvedSkillCatalogRoot> {
  try {
    return await resolveFromNexus(opts);
  } catch (error) {
    const cached = await tryVerifiedCache(opts);
    if (cached !== undefined) {
      return {
        ...cached,
        warnings: fallbackWarnings(opts.skills, "cache", error),
      };
    }

    if (opts.policy === "required") {
      throw safeSurfaceError(error);
    }

    const local = await tryLocalFallback(opts);
    if (local !== undefined) {
      return {
        ...local,
        warnings: fallbackWarnings(opts.skills, "local", error),
      };
    }

    throw new SkillCatalogUnavailableError(
      "Nexus skill catalog is unavailable and no verified cache or local fallback could resolve requested skills",
      { cause: safeSurfaceError(error) },
    );
  }
}
