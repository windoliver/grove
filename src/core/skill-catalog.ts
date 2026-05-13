import { Buffer } from "node:buffer";
import { createPublicKey, verify } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { hash } from "blake3";
import { z } from "zod";

import { readStoredZip } from "../shared/zip.js";
import type { SkillCatalogTrustedKey } from "./config.js";

const BLAKE3_PATTERN = /^blake3:[0-9a-f]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ED25519_SIGNATURE_BYTES = 64;

export class SkillCatalogTrustError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SkillCatalogTrustError";
  }
}

export class SkillCatalogUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SkillCatalogUnavailableError";
  }
}

export class SkillBundleIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SkillBundleIntegrityError";
  }
}

interface SkillCatalogEntryData {
  readonly version: string;
  readonly bundleHash: string;
  readonly sizeBytes: number;
}

interface SkillCatalogIndexData {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly skills: Readonly<Record<string, SkillCatalogEntryData>>;
}

interface SkillCatalogSignatureData {
  readonly schemaVersion: 1;
  readonly keyId: string;
  readonly algorithm: "ed25519";
  readonly signature: string;
}

const SkillCatalogEntrySchema: z.ZodType<SkillCatalogEntryData> = z
  .object({
    version: z.string().min(1).max(128),
    bundleHash: z.string().regex(BLAKE3_PATTERN),
    sizeBytes: z.number().int().min(1),
  })
  .strict();

const SkillNameSchema = z.string().min(1).max(128);

const SkillCatalogIndexSchema: z.ZodType<SkillCatalogIndexData> = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().min(1),
    skills: z.record(SkillNameSchema, SkillCatalogEntrySchema),
  })
  .strict();

const SkillCatalogSignatureSchema: z.ZodType<SkillCatalogSignatureData> = z
  .object({
    schemaVersion: z.literal(1),
    keyId: z.string().min(1).max(128),
    algorithm: z.literal("ed25519"),
    signature: z.string().min(1),
  })
  .strict();

export type SkillCatalogEntry = z.infer<typeof SkillCatalogEntrySchema>;
export type SkillCatalogIndex = z.infer<typeof SkillCatalogIndexSchema>;
export type SkillCatalogSignature = z.infer<typeof SkillCatalogSignatureSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeJsonString(value: string): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("canonicalJson requires JSON-compatible data");
  }
  return encoded;
}

function serializeCanonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("canonicalJson requires finite numbers");
      }
      {
        const encoded = JSON.stringify(value);
        if (encoded === undefined) {
          throw new TypeError("canonicalJson requires JSON-compatible data");
        }
        return encoded;
      }
    case "string":
      return serializeJsonString(value);
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      throw new TypeError("canonicalJson requires JSON-compatible data");
  }

  if (Array.isArray(value)) {
    const entries: string[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) {
        throw new TypeError("canonicalJson requires dense arrays");
      }
      entries.push(serializeCanonicalJson(value[index]));
    }
    return `[${entries.join(",")}]`;
  }

  if (!isRecord(value)) {
    throw new TypeError("canonicalJson requires JSON-compatible objects");
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("canonicalJson requires plain objects");
  }

  const entries: string[] = [];
  for (const key of Object.keys(value).sort()) {
    entries.push(`${serializeJsonString(key)}:${serializeCanonicalJson(value[key])}`);
  }
  return `{${entries.join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  return serializeCanonicalJson(value);
}

export function parseSkillCatalogIndex(raw: string): SkillCatalogIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("skill catalog index is not valid JSON");
  }

  const result = SkillCatalogIndexSchema.safeParse(parsed);
  if (!result.success) {
    const messages = result.error.issues.map((issue) => {
      const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
      return `  - ${path}: ${issue.message}`;
    });
    throw new Error(`Invalid skill catalog index:\n${messages.join("\n")}`);
  }
  return result.data;
}

export function parseSkillCatalogSignature(raw: string): SkillCatalogSignature {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("skill catalog signature is not valid JSON");
  }

  const result = SkillCatalogSignatureSchema.safeParse(parsed);
  if (!result.success) {
    const messages = result.error.issues.map((issue) => {
      const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
      return `  - ${path}: ${issue.message}`;
    });
    throw new Error(`Invalid skill catalog signature:\n${messages.join("\n")}`);
  }
  return result.data;
}

function decodeCanonicalBase64(value: string): Buffer {
  if (value.length === 0 || !BASE64_PATTERN.test(value)) {
    throw new Error("value is not canonical base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("value is not canonical base64");
  }
  return decoded;
}

export function verifyCatalogSignature(opts: {
  readonly indexBytes: Uint8Array;
  readonly signature: SkillCatalogSignature;
  readonly trustedKeys: readonly SkillCatalogTrustedKey[];
}): { readonly keyId: string } {
  const signatureResult = SkillCatalogSignatureSchema.safeParse(opts.signature);
  if (!signatureResult.success) {
    throw new SkillCatalogTrustError("Invalid skill catalog signature schema");
  }
  const signature = signatureResult.data;

  const trustedKey = opts.trustedKeys.find((key) => key.id === signature.keyId);
  if (trustedKey === undefined) {
    throw new SkillCatalogTrustError(`Unknown skill catalog signing key: ${signature.keyId}`);
  }
  if (trustedKey.algorithm !== "ed25519") {
    throw new SkillCatalogTrustError("Unsupported skill catalog trusted key algorithm");
  }

  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey({
      key: decodeCanonicalBase64(trustedKey.publicKeySpkiDer),
      format: "der",
      type: "spki",
    });
  } catch (error) {
    throw new SkillCatalogTrustError("Invalid skill catalog trusted key material", {
      cause: error,
    });
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new SkillCatalogTrustError("Skill catalog trusted key is not ed25519");
  }

  let signatureBytes: Buffer;
  try {
    signatureBytes = decodeCanonicalBase64(signature.signature);
  } catch (error) {
    throw new SkillCatalogTrustError("Malformed skill catalog signature", { cause: error });
  }
  if (signatureBytes.length !== ED25519_SIGNATURE_BYTES) {
    throw new SkillCatalogTrustError("Malformed skill catalog signature");
  }

  let verified: boolean;
  try {
    verified = verify(null, opts.indexBytes, publicKey, signatureBytes);
  } catch (error) {
    throw new SkillCatalogTrustError("Skill catalog signature verification failed", {
      cause: error,
    });
  }

  if (!verified) {
    throw new SkillCatalogTrustError("Skill catalog signature verification failed");
  }
  return { keyId: signature.keyId };
}

export function verifyBundleHash(bytes: Uint8Array, expectedHash: string): string {
  if (!BLAKE3_PATTERN.test(expectedHash)) {
    throw new SkillBundleIntegrityError("Invalid skill bundle hash format");
  }

  const actualHash = `blake3:${hash(bytes).toString("hex")}`;
  if (actualHash !== expectedHash) {
    throw new SkillBundleIntegrityError("Skill bundle hash mismatch");
  }
  return actualHash;
}

export async function unpackSkillBundle(bytes: Uint8Array, targetDir: string): Promise<void> {
  let entries: ReturnType<typeof readStoredZip>;
  try {
    entries = readStoredZip(bytes);
  } catch (error) {
    throw new SkillBundleIntegrityError("Invalid skill bundle ZIP", { cause: error });
  }

  if (!entries.some((entry) => entry.path === "SKILL.md")) {
    throw new SkillBundleIntegrityError("Skill bundle is missing SKILL.md");
  }

  const parentDir = dirname(targetDir);
  await mkdir(parentDir, { recursive: true });
  const tempDir = await mkdtemp(join(parentDir, `.${basename(targetDir)}.tmp-`));
  let installed = false;

  try {
    for (const entry of entries) {
      const targetPath = join(tempDir, entry.path);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, entry.bytes);
    }

    await rm(targetDir, { recursive: true, force: true });
    await rename(tempDir, targetDir);
    installed = true;
  } finally {
    if (!installed) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
