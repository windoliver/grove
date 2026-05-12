# Nexus-Hosted Skill Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build automatic Nexus-mode skill resolution from a signed Nexus catalog, with verified cache and local fallback, while preserving current local skill injection behavior.

**Architecture:** Add a small core catalog module for canonical JSON, Ed25519 verification, BLAKE3 bundle verification, and stored-ZIP unpacking. Add a Nexus adapter that reads signed catalog files from zone-scoped VFS paths, materializes verified skills into `.grove/cache/skills`, and exposes a resolver that bootstrap/spawn paths can call before `injectSkills()`. Non-Nexus mode continues using the current local two-layer injector.

**Tech Stack:** TypeScript strict mode, Bun test runner, Node crypto Ed25519 APIs, `blake3`, existing `NexusClient`, existing stored ZIP writer in `src/shared/zip.ts`, Biome.

---

## Scope Boundary

This plan implements the runtime path: fetch, verify, cache, fallback, and inject. It does not implement `grove skill publish`; the design already lists that as a concrete child issue. Runtime tests seed `MockNexusClient` directly with signed catalog files and bundles.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/core/config.ts` | Parse and serialize local trusted skill catalog settings in `.grove/grove.json`. |
| `src/core/config.test.ts` | Cover skill catalog config parsing, defaults, rejection, and round trip. |
| `src/nexus/vfs-paths.ts` | Build safe zone-scoped Nexus skill catalog VFS paths. |
| `src/nexus/vfs-paths.test.ts` | Cover path encoding and exact catalog paths. |
| `src/shared/zip.ts` | Add stored-ZIP reader helpers next to the existing stored-ZIP writer. |
| `src/shared/zip.test.ts` | Cover ZIP read round trip, CRC checks, unsupported compression, and unsafe paths. |
| `src/core/skill-catalog.ts` | Catalog schemas, canonical JSON, signature verification, bundle hash checks, unpack-to-directory helper, structured errors. |
| `src/core/skill-catalog.test.ts` | Core unit tests for canonical JSON, Ed25519 verification, hash checks, unpacking, and rejection cases. |
| `src/nexus/nexus-skill-catalog.ts` | Nexus catalog reader/cache resolver. Depends on `NexusClient`, `skill-catalog`, and VFS path helpers. |
| `src/nexus/nexus-skill-catalog.test.ts` | MockNexusClient tests for signed fetch, cache fallback, local fallback, and required policy. |
| `src/core/workspace-bootstrap.ts` | Accept an optional skill resolver dependency before falling back to current local injector. |
| `src/core/workspace-bootstrap.test.ts` | Prove resolved remote roots are injected and local behavior is unchanged. |
| `src/core/session-orchestrator.ts` | Create Nexus-aware skill resolver when Nexus URL/config are present. |
| `src/tui/spawn-manager.ts` | Mirror resolver use in TUI spawn path. |
| `src/nexus/index.ts` | Export the Nexus skill catalog resolver and path helpers needed by callers/tests. |

## Task 1: Config schema and Nexus VFS paths

**Files:**
- Modify: `src/core/config.ts`
- Modify: `src/core/config.test.ts`
- Modify: `src/nexus/vfs-paths.ts`
- Modify: `src/nexus/vfs-paths.test.ts`

- [ ] **Step 1: Write failing config tests**

Add these tests inside `describe("parseGroveConfig", ...)` in `src/core/config.test.ts`:

```ts
  test("parses skill catalog config with trusted keys", () => {
    const config = parseGroveConfig(
      JSON.stringify({
        name: "swarm",
        mode: "nexus",
        nexusUrl: "http://localhost:4000",
        skillCatalog: {
          policy: "required",
          trustedKeys: [
            {
              id: "root-key",
              algorithm: "ed25519",
              publicKeySpkiDer: "MCowBQYDK2VwAyEA0000000000000000000000000000000000000000000=",
            },
          ],
          cacheTtlSeconds: 60,
        },
      }),
    );

    expect(config.skillCatalog?.policy).toBe("required");
    expect(config.skillCatalog?.trustedKeys).toHaveLength(1);
    expect(config.skillCatalog?.trustedKeys[0]?.id).toBe("root-key");
    expect(config.skillCatalog?.cacheTtlSeconds).toBe(60);
  });

  test("defaults skill catalog policy when omitted", () => {
    const config = parseGroveConfig(
      JSON.stringify({
        name: "swarm",
        mode: "nexus",
        nexusUrl: "http://localhost:4000",
        skillCatalog: {
          trustedKeys: [],
        },
      }),
    );

    expect(config.skillCatalog?.policy).toBe("warn-and-fallback");
    expect(config.skillCatalog?.trustedKeys).toEqual([]);
  });
```

Add these tests inside `describe("parseGroveConfig errors", ...)`:

```ts
  test("rejects unknown skill catalog policy", () => {
    expect(() =>
      parseGroveConfig(
        JSON.stringify({
          name: "x",
          mode: "nexus",
          nexusUrl: "http://localhost:4000",
          skillCatalog: { policy: "trust-nexus", trustedKeys: [] },
        }),
      ),
    ).toThrow("Invalid grove.json");
  });

  test("rejects non-ed25519 skill catalog key algorithms", () => {
    expect(() =>
      parseGroveConfig(
        JSON.stringify({
          name: "x",
          mode: "nexus",
          nexusUrl: "http://localhost:4000",
          skillCatalog: {
            trustedKeys: [
              { id: "root-key", algorithm: "rsa", publicKeySpkiDer: "abc" },
            ],
          },
        }),
      ),
    ).toThrow("Invalid grove.json");
  });
```

Add this test inside `describe("writeGroveConfig", ...)`:

```ts
  test("round-trips skill catalog config", () => {
    const original: GroveConfig = {
      name: "nexus-grove",
      mode: "nexus",
      nexusUrl: "http://nexus:4000",
      skillCatalog: {
        policy: "required",
        trustedKeys: [
          {
            id: "root-key",
            algorithm: "ed25519",
            publicKeySpkiDer: "MCowBQYDK2VwAyEA0000000000000000000000000000000000000000000=",
          },
        ],
        cacheTtlSeconds: 120,
      },
    };

    writeGroveConfig(original, tmpPath);

    const parsed = parseGroveConfig(readFileSync(tmpPath, "utf-8"));
    expect(parsed.skillCatalog).toEqual(original.skillCatalog);
  });
```

- [ ] **Step 2: Write failing VFS path tests**

Add these imports to `src/nexus/vfs-paths.test.ts`:

```ts
  skillCatalogBundlePath,
  skillCatalogIndexPath,
  skillCatalogSignaturePath,
```

Add this test block:

```ts
describe("skill catalog paths", () => {
  test("constructs zone-scoped skill catalog paths", () => {
    expect(skillCatalogIndexPath("zone1")).toBe("/zones/zone1/skill-catalog/index.json");
    expect(skillCatalogSignaturePath("zone1")).toBe("/zones/zone1/skill-catalog/index.sig");
    expect(skillCatalogBundlePath("zone1", "blake3:abc123")).toBe(
      "/zones/zone1/skill-catalog/bundles/blake3:abc123.zip",
    );
  });

  test("encodes zone and bundle hash segments", () => {
    expect(skillCatalogIndexPath("../zone")).toBe(
      "/zones/..%2Fzone/skill-catalog/index.json",
    );
    expect(skillCatalogBundlePath("zone/one", "blake3:a/b")).toBe(
      "/zones/zone%2Fone/skill-catalog/bundles/blake3:a%2Fb.zip",
    );
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
bun test src/core/config.test.ts src/nexus/vfs-paths.test.ts
```

Expected: FAIL because `skillCatalog` is rejected as an unknown field and skill catalog VFS helpers are not exported.

- [ ] **Step 4: Implement config types and schema**

In `src/core/config.ts`, add these exported types near `GroveMode`:

```ts
export type SkillCatalogPolicy = "warn-and-fallback" | "required";

export interface SkillCatalogTrustedKey {
  readonly id: string;
  readonly algorithm: "ed25519";
  readonly publicKeySpkiDer: string;
}

export interface SkillCatalogConfig {
  readonly policy: SkillCatalogPolicy;
  readonly trustedKeys: readonly SkillCatalogTrustedKey[];
  readonly cacheTtlSeconds?: number | undefined;
}
```

Add this field to `GroveConfig`:

```ts
  readonly skillCatalog?: SkillCatalogConfig | undefined;
```

Add schemas before `GroveConfigSchema`:

```ts
const SkillCatalogPolicySchema = z
  .enum(["warn-and-fallback", "required"])
  .default("warn-and-fallback");

const SkillCatalogTrustedKeySchema = z
  .object({
    id: z.string().min(1).max(128),
    algorithm: z.literal("ed25519"),
    publicKeySpkiDer: z.string().min(1).max(4096),
  })
  .strict();

const SkillCatalogSchema: z.ZodType<SkillCatalogConfig> = z
  .object({
    policy: SkillCatalogPolicySchema,
    trustedKeys: z.array(SkillCatalogTrustedKeySchema).max(20).default([]),
    cacheTtlSeconds: z.number().int().min(1).max(31_536_000).optional(),
  })
  .strict();
```

Add this property to the `GroveConfigSchema` object:

```ts
    skillCatalog: SkillCatalogSchema.optional(),
```

Add this serialization line to `writeGroveConfig()`:

```ts
  if (config.skillCatalog !== undefined) obj.skillCatalog = config.skillCatalog;
```

- [ ] **Step 5: Implement VFS path helpers**

In `src/nexus/vfs-paths.ts`, add:

```ts
// ---------------------------------------------------------------------------
// Skill catalog paths
// ---------------------------------------------------------------------------

/** Path to the signed skill catalog index JSON. */
export function skillCatalogIndexPath(zoneId: string): string {
  return `/zones/${encodeSegment(zoneId)}/skill-catalog/index.json`;
}

/** Path to the skill catalog signature sidecar. */
export function skillCatalogSignaturePath(zoneId: string): string {
  return `/zones/${encodeSegment(zoneId)}/skill-catalog/index.sig`;
}

/** Path to an immutable skill bundle ZIP selected by a verified bundle hash. */
export function skillCatalogBundlePath(zoneId: string, bundleHash: string): string {
  return `/zones/${encodeSegment(zoneId)}/skill-catalog/bundles/${encodeSegment(bundleHash)}.zip`;
}
```

- [ ] **Step 6: Run tests and typecheck**

Run:

```bash
bun test src/core/config.test.ts src/nexus/vfs-paths.test.ts
bun run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/config.ts src/core/config.test.ts src/nexus/vfs-paths.ts src/nexus/vfs-paths.test.ts
git commit -m "feat(skills): add skill catalog config and Nexus paths"
```

## Task 2: Stored ZIP reader

**Files:**
- Modify: `src/shared/zip.ts`
- Modify: `src/shared/zip.test.ts`

- [ ] **Step 1: Write failing ZIP reader tests**

Add `readStoredZip` to the import in `src/shared/zip.test.ts`:

```ts
import { crc32, createStoredZip, readStoredZip } from "./zip.js";
```

Add these tests inside `describe("createStoredZip", ...)`:

```ts
  test("readStoredZip round-trips writer output", () => {
    const zip = createStoredZip([
      { path: "SKILL.md", bytes: textEncoder.encode("skill") },
      { path: "references/guide.md", bytes: textEncoder.encode("guide") },
    ]);

    const entries = readStoredZip(zip);

    expect(entries.map((entry) => entry.path)).toEqual(["SKILL.md", "references/guide.md"]);
    expect(textDecoder.decode(entries[0]?.bytes)).toBe("skill");
    expect(textDecoder.decode(entries[1]?.bytes)).toBe("guide");
  });

  test("readStoredZip rejects CRC mismatch", () => {
    const zip = createStoredZip([{ path: "SKILL.md", bytes: textEncoder.encode("skill") }]);
    const corrupted = new Uint8Array(zip);
    corrupted[30 + textEncoder.encode("SKILL.md").length] =
      (corrupted[30 + textEncoder.encode("SKILL.md").length] ?? 0) ^ 0xff;

    expect(() => readStoredZip(corrupted)).toThrow(/crc/i);
  });

  test("readStoredZip rejects unsupported compression methods", () => {
    const zip = createStoredZip([{ path: "SKILL.md", bytes: textEncoder.encode("skill") }]);
    const compressed = new Uint8Array(zip);
    compressed[8] = 8;

    expect(() => readStoredZip(compressed)).toThrow(/compression method/i);
  });

  test("readStoredZip rejects unsafe central-directory paths", () => {
    const unsafe = createStoredZip([{ path: "SKILL.md", bytes: textEncoder.encode("skill") }]);
    const patched = new Uint8Array(unsafe);
    const eocdOffset = patched.length - 22;
    const centralStart = readUInt32(patched, eocdOffset + 16);
    patched.set(textEncoder.encode("/KILL.md"), centralStart + 46);

    expect(() => readStoredZip(patched)).toThrow(/unsafe zip entry/i);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun test src/shared/zip.test.ts -t "readStoredZip"
```

Expected: FAIL because `readStoredZip` is not exported.

- [ ] **Step 3: Implement reader helpers**

In `src/shared/zip.ts`, export this interface near `ZipEntryInput`:

```ts
export interface ZipEntryOutput {
  readonly path: string;
  readonly bytes: Uint8Array;
}
```

Add these helper functions below `createStoredZip()`:

```ts
function readUInt16(bytes: Uint8Array, offset: number): number {
  if (offset + 2 > bytes.length) throw new Error("invalid zip: truncated uint16");
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;
}

function readUInt32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) throw new Error("invalid zip: truncated uint32");
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  for (let offset = bytes.length - 22; offset >= 0; offset--) {
    if (readUInt32(bytes, offset) === 0x06054b50) return offset;
  }
  throw new Error("invalid zip: missing end of central directory");
}
```

Add this exported reader:

```ts
export function readStoredZip(bytes: Uint8Array): readonly ZipEntryOutput[] {
  const eocdOffset = findEndOfCentralDirectory(bytes);
  const entryCount = readUInt16(bytes, eocdOffset + 8);
  let centralOffset = readUInt32(bytes, eocdOffset + 16);
  const entries: ZipEntryOutput[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < entryCount; index++) {
    if (readUInt32(bytes, centralOffset) !== 0x02014b50) {
      throw new Error("invalid zip: missing central directory record");
    }
    const compressionMethod = readUInt16(bytes, centralOffset + 10);
    if (compressionMethod !== 0) {
      throw new Error(`unsupported zip compression method: ${compressionMethod}`);
    }
    const expectedCrc = readUInt32(bytes, centralOffset + 16);
    const compressedSize = readUInt32(bytes, centralOffset + 20);
    const uncompressedSize = readUInt32(bytes, centralOffset + 24);
    if (compressedSize !== uncompressedSize) {
      throw new Error("invalid stored zip: compressed and uncompressed sizes differ");
    }
    const nameLength = readUInt16(bytes, centralOffset + 28);
    const extraLength = readUInt16(bytes, centralOffset + 30);
    const commentLength = readUInt16(bytes, centralOffset + 32);
    const localOffset = readUInt32(bytes, centralOffset + 42);
    const nameStart = centralOffset + 46;
    const name = new TextDecoder().decode(bytes.slice(nameStart, nameStart + nameLength));
    validateEntryPath(name);
    if (seen.has(name)) throw new Error(`duplicate zip entry path: ${name}`);
    seen.add(name);

    if (readUInt32(bytes, localOffset) !== 0x04034b50) {
      throw new Error("invalid zip: missing local file header");
    }
    const localNameLength = readUInt16(bytes, localOffset + 26);
    const localExtraLength = readUInt16(bytes, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) throw new Error("invalid zip: entry data exceeds archive size");
    const entryBytes = bytes.slice(dataStart, dataEnd);
    const actualCrc = crc32(entryBytes);
    if (actualCrc !== expectedCrc) {
      throw new Error(`zip crc mismatch for ${name}`);
    }
    entries.push({ path: name, bytes: entryBytes });
    centralOffset = nameStart + nameLength + extraLength + commentLength;
  }

  return entries;
}
```

- [ ] **Step 4: Run ZIP tests**

Run:

```bash
bun test src/shared/zip.test.ts
bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/zip.ts src/shared/zip.test.ts
git commit -m "feat(zip): read stored ZIP archives"
```

## Task 3: Core signed skill catalog module

**Files:**
- Create: `src/core/skill-catalog.ts`
- Create: `src/core/skill-catalog.test.ts`

- [ ] **Step 1: Write failing core tests**

Create `src/core/skill-catalog.test.ts`:

```ts
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { hash } from "blake3";
import { createStoredZip } from "../shared/zip.js";
import {
  SkillBundleIntegrityError,
  SkillCatalogTrustError,
  canonicalJson,
  parseSkillCatalogIndex,
  unpackSkillBundle,
  verifyBundleHash,
  verifyCatalogSignature,
} from "./skill-catalog.js";

const encoder = new TextEncoder();

function keyPair(): {
  readonly publicKeySpkiDer: string;
  readonly privateKey: KeyObject;
} {
  const pair = generateKeyPairSync("ed25519");
  const publicKeySpkiDer = Buffer.from(
    pair.publicKey.export({ format: "der", type: "spki" }),
  ).toString("base64");
  return { publicKeySpkiDer, privateKey: pair.privateKey };
}

function signedIndex(): {
  readonly indexBytes: Uint8Array;
  readonly signature: { readonly schemaVersion: 1; readonly keyId: string; readonly algorithm: "ed25519"; readonly signature: string };
  readonly trustedKey: { readonly id: string; readonly algorithm: "ed25519"; readonly publicKeySpkiDer: string };
} {
  const keys = keyPair();
  const index = {
    schemaVersion: 1,
    generatedAt: "2026-05-07T00:00:00Z",
    skills: {
      grove: {
        version: "2026.05.07",
        bundleHash: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
        sizeBytes: 10,
      },
    },
  };
  const indexBytes = encoder.encode(canonicalJson(index));
  return {
    indexBytes,
    signature: {
      schemaVersion: 1,
      keyId: "root-key",
      algorithm: "ed25519",
      signature: sign(null, indexBytes, keys.privateKey).toString("base64"),
    },
    trustedKey: {
      id: "root-key",
      algorithm: "ed25519",
      publicKeySpkiDer: keys.publicKeySpkiDer,
    },
  };
}

describe("canonicalJson", () => {
  test("sorts object keys recursively", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}');
  });
});

describe("skill catalog signature verification", () => {
  test("accepts a matching ed25519 signature", () => {
    const fixture = signedIndex();
    expect(
      verifyCatalogSignature({
        indexBytes: fixture.indexBytes,
        signature: fixture.signature,
        trustedKeys: [fixture.trustedKey],
      }),
    ).toEqual({ keyId: "root-key" });
  });

  test("rejects unknown key ids and bad signatures", () => {
    const fixture = signedIndex();
    expect(() =>
      verifyCatalogSignature({
        indexBytes: fixture.indexBytes,
        signature: { ...fixture.signature, keyId: "other-key" },
        trustedKeys: [fixture.trustedKey],
      }),
    ).toThrow(SkillCatalogTrustError);

    const changed = encoder.encode(`${new TextDecoder().decode(fixture.indexBytes)}\n`);
    expect(() =>
      verifyCatalogSignature({
        indexBytes: changed,
        signature: fixture.signature,
        trustedKeys: [fixture.trustedKey],
      }),
    ).toThrow(SkillCatalogTrustError);
  });
});

describe("skill catalog schemas and bundles", () => {
  test("parses valid index JSON", () => {
    const parsed = parseSkillCatalogIndex(
      '{"generatedAt":"2026-05-07T00:00:00Z","schemaVersion":1,"skills":{"grove":{"bundleHash":"blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sizeBytes":1,"version":"1"}}}',
    );
    expect(parsed.skills.grove?.version).toBe("1");
  });

  test("verifies bundle hash before unpack", () => {
    const bytes = encoder.encode("bundle");
    const bundleHash = `blake3:${hash(bytes).toString("hex")}`;
    expect(verifyBundleHash(bytes, bundleHash)).toBe(bundleHash);
    expect(() => verifyBundleHash(bytes, "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toThrow(
      SkillBundleIntegrityError,
    );
  });

  test("unpacks safe bundle entries and requires SKILL.md", async () => {
    const root = mkdtempSync(join(tmpdir(), "grove-skill-catalog-"));
    try {
      const zip = createStoredZip([
        { path: "SKILL.md", bytes: encoder.encode("skill") },
        { path: "references/guide.md", bytes: encoder.encode("guide") },
      ]);
      await unpackSkillBundle(zip, join(root, "skill"));
      expect(readFileSync(join(root, "skill", "SKILL.md"), "utf-8")).toBe("skill");
      expect(readFileSync(join(root, "skill", "references", "guide.md"), "utf-8")).toBe(
        "guide",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects bundles without SKILL.md", async () => {
    const root = mkdtempSync(join(tmpdir(), "grove-skill-catalog-"));
    try {
      const zip = createStoredZip([{ path: "README.md", bytes: encoder.encode("readme") }]);
      await expect(unpackSkillBundle(zip, join(root, "skill"))).rejects.toThrow(
        SkillBundleIntegrityError,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun test src/core/skill-catalog.test.ts
```

Expected: FAIL because `src/core/skill-catalog.ts` does not exist.

- [ ] **Step 3: Implement `src/core/skill-catalog.ts`**

Create `src/core/skill-catalog.ts` with these exports:

```ts
import { createPublicKey, verify } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hash } from "blake3";
import { z } from "zod";
import { readStoredZip } from "../shared/zip.js";
import type { SkillCatalogTrustedKey } from "./config.js";

const BLAKE3_PATTERN = /^blake3:[0-9a-f]{64}$/;

export class SkillCatalogTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillCatalogTrustError";
  }
}

export class SkillCatalogUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillCatalogUnavailableError";
  }
}

export class SkillBundleIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillBundleIntegrityError";
  }
}

const SkillCatalogEntrySchema = z
  .object({
    version: z.string().min(1).max(128),
    bundleHash: z.string().regex(BLAKE3_PATTERN),
    sizeBytes: z.number().int().min(1),
  })
  .strict();

const SkillCatalogIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().min(1),
    skills: z.record(z.string().min(1).max(128), SkillCatalogEntrySchema),
  })
  .strict();

const SkillCatalogSignatureSchema = z
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

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;

  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function parseSkillCatalogIndex(raw: string): SkillCatalogIndex {
  const parsed = JSON.parse(raw) as unknown;
  return SkillCatalogIndexSchema.parse(parsed);
}

export function parseSkillCatalogSignature(raw: string): SkillCatalogSignature {
  const parsed = JSON.parse(raw) as unknown;
  return SkillCatalogSignatureSchema.parse(parsed);
}

export function verifyCatalogSignature(opts: {
  readonly indexBytes: Uint8Array;
  readonly signature: SkillCatalogSignature;
  readonly trustedKeys: readonly SkillCatalogTrustedKey[];
}): { readonly keyId: string } {
  const key = opts.trustedKeys.find((candidate) => candidate.id === opts.signature.keyId);
  if (key === undefined) {
    throw new SkillCatalogTrustError(`Unknown skill catalog signing key: ${opts.signature.keyId}`);
  }
  const publicKey = createPublicKey({
    key: Buffer.from(key.publicKeySpkiDer, "base64"),
    format: "der",
    type: "spki",
  });
  const ok = verify(null, opts.indexBytes, publicKey, Buffer.from(opts.signature.signature, "base64"));
  if (!ok) throw new SkillCatalogTrustError("Skill catalog signature verification failed");
  return { keyId: key.id };
}

export function verifyBundleHash(bytes: Uint8Array, expectedHash: string): string {
  if (!BLAKE3_PATTERN.test(expectedHash)) {
    throw new SkillBundleIntegrityError(`Invalid bundle hash: ${expectedHash}`);
  }
  const actual = `blake3:${hash(bytes).toString("hex")}`;
  if (actual !== expectedHash) {
    throw new SkillBundleIntegrityError(`Skill bundle hash mismatch: expected ${expectedHash}, got ${actual}`);
  }
  return actual;
}

export async function unpackSkillBundle(bytes: Uint8Array, targetDir: string): Promise<void> {
  const entries = readStoredZip(bytes);
  if (!entries.some((entry) => entry.path === "SKILL.md")) {
    throw new SkillBundleIntegrityError("Skill bundle is missing SKILL.md");
  }
  for (const entry of entries) {
    const targetPath = join(targetDir, entry.path);
    await mkdir(join(targetPath, ".."), { recursive: true });
    await writeFile(targetPath, entry.bytes);
  }
}
```

- [ ] **Step 4: Run core tests**

Run:

```bash
bun test src/core/skill-catalog.test.ts src/shared/zip.test.ts
bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/skill-catalog.ts src/core/skill-catalog.test.ts
git commit -m "feat(skills): verify signed skill catalogs"
```

## Task 4: Nexus skill catalog resolver and cache

**Files:**
- Create: `src/nexus/nexus-skill-catalog.ts`
- Create: `src/nexus/nexus-skill-catalog.test.ts`
- Modify: `src/nexus/index.ts`

- [ ] **Step 1: Write failing Nexus resolver tests**

Create `src/nexus/nexus-skill-catalog.test.ts`:

```ts
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { hash } from "blake3";
import { canonicalJson } from "../core/skill-catalog.js";
import { createStoredZip } from "../shared/zip.js";
import { MockNexusClient } from "./mock-client.js";
import {
  resolveNexusSkillCatalogRoot,
  writeSkillCatalogToNexusForTest,
} from "./nexus-skill-catalog.js";

const encoder = new TextEncoder();

function signingFixture(): {
  readonly keyId: string;
  readonly publicKeySpkiDer: string;
  readonly privateKey: KeyObject;
} {
  const pair = generateKeyPairSync("ed25519");
  return {
    keyId: "root-key",
    publicKeySpkiDer: Buffer.from(
      pair.publicKey.export({ format: "der", type: "spki" }),
    ).toString("base64"),
    privateKey: pair.privateKey,
  };
}

async function seedNexus(opts: {
  readonly client: MockNexusClient;
  readonly zoneId: string;
  readonly privateKey: KeyObject;
  readonly keyId: string;
  readonly skillContent?: string;
}): Promise<void> {
  const bundle = createStoredZip([
    { path: "SKILL.md", bytes: encoder.encode(opts.skillContent ?? "nexus-skill") },
  ]);
  const bundleHash = `blake3:${hash(bundle).toString("hex")}`;
  const index = {
    schemaVersion: 1,
    generatedAt: "2026-05-07T00:00:00Z",
    skills: {
      grove: { version: "1", bundleHash, sizeBytes: bundle.byteLength },
    },
  };
  const indexBytes = encoder.encode(canonicalJson(index));
  const signature = {
    schemaVersion: 1,
    keyId: opts.keyId,
    algorithm: "ed25519" as const,
    signature: sign(null, indexBytes, opts.privateKey).toString("base64"),
  };
  await writeSkillCatalogToNexusForTest({
    client: opts.client,
    zoneId: opts.zoneId,
    indexBytes,
    signatureBytes: encoder.encode(JSON.stringify(signature)),
    bundleHash,
    bundleBytes: bundle,
  });
}

describe("resolveNexusSkillCatalogRoot", () => {
  test("fetches signed Nexus catalog and materializes requested skill root", async () => {
    const root = mkdtempSync(join(tmpdir(), "grove-nexus-skills-"));
    const client = new MockNexusClient();
    const keys = signingFixture();
    try {
      await seedNexus({ client, zoneId: "zone1", privateKey: keys.privateKey, keyId: keys.keyId });
      const result = await resolveNexusSkillCatalogRoot({
        client,
        zoneId: "zone1",
        cacheRoot: join(root, ".grove", "cache", "skills"),
        skills: ["grove"],
        policy: "warn-and-fallback",
        trustedKeys: [
          { id: keys.keyId, algorithm: "ed25519", publicKeySpkiDer: keys.publicKeySpkiDer },
        ],
        localFallbackRoots: [],
      });

      expect(result.source).toBe("nexus");
      expect(readFileSync(join(result.root, "grove", "SKILL.md"), "utf-8")).toBe("nexus-skill");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses verified cache when Nexus becomes unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "grove-nexus-skills-"));
    const client = new MockNexusClient();
    const keys = signingFixture();
    try {
      await seedNexus({ client, zoneId: "zone1", privateKey: keys.privateKey, keyId: keys.keyId });
      const base = {
        client,
        zoneId: "zone1",
        cacheRoot: join(root, ".grove", "cache", "skills"),
        skills: ["grove"],
        policy: "warn-and-fallback" as const,
        trustedKeys: [
          { id: keys.keyId, algorithm: "ed25519" as const, publicKeySpkiDer: keys.publicKeySpkiDer },
        ],
        localFallbackRoots: [],
      };
      await resolveNexusSkillCatalogRoot(base);
      client.setFailureMode({ failNext: 10, failWith: "connection" });
      const result = await resolveNexusSkillCatalogRoot(base);

      expect(result.source).toBe("cache");
      expect(readFileSync(join(result.root, "grove", "SKILL.md"), "utf-8")).toBe("nexus-skill");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("falls back to local root under warn-and-fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "grove-nexus-skills-"));
    const client = new MockNexusClient();
    try {
      const localSkill = join(root, "local", "grove");
      mkdirSync(localSkill, { recursive: true });
      writeFileSync(join(localSkill, "SKILL.md"), "local-skill", "utf-8");
      const result = await resolveNexusSkillCatalogRoot({
        client,
        zoneId: "zone1",
        cacheRoot: join(root, ".grove", "cache", "skills"),
        skills: ["grove"],
        policy: "warn-and-fallback",
        trustedKeys: [],
        localFallbackRoots: [join(root, "local")],
      });

      expect(result.source).toBe("local");
      expect(readFileSync(join(result.root, "grove", "SKILL.md"), "utf-8")).toBe("local-skill");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails required policy without verified Nexus or cache", async () => {
    const root = mkdtempSync(join(tmpdir(), "grove-nexus-skills-"));
    const client = new MockNexusClient();
    try {
      await expect(
        resolveNexusSkillCatalogRoot({
          client,
          zoneId: "zone1",
          cacheRoot: join(root, ".grove", "cache", "skills"),
          skills: ["grove"],
          policy: "required",
          trustedKeys: [],
          localFallbackRoots: [],
        }),
      ).rejects.toThrow(/trusted keys|catalog|required/i);
      expect(existsSync(join(root, ".grove", "cache", "skills", "resolved"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun test src/nexus/nexus-skill-catalog.test.ts
```

Expected: FAIL because `src/nexus/nexus-skill-catalog.ts` does not exist.

- [ ] **Step 3: Implement resolver shape**

Create `src/nexus/nexus-skill-catalog.ts` with these exported interfaces and helper:

```ts
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SkillCatalogPolicy, SkillCatalogTrustedKey } from "../core/config.js";
import {
  SkillCatalogTrustError,
  SkillCatalogUnavailableError,
  parseSkillCatalogIndex,
  parseSkillCatalogSignature,
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
```

Implement `writeSkillCatalogToNexusForTest()` for tests and future test fixtures:

```ts
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
```

- [ ] **Step 4: Implement fetch, cache, and local fallback**

In the same file, add helper functions:

```ts
const decoder = new TextDecoder();

function cacheSkillDir(cacheRoot: string, skillName: string, version: string, bundleHash: string): string {
  return join(cacheRoot, "unpacked", skillName, version, bundleHash);
}

function resolvedRoot(cacheRoot: string, skills: readonly string[], suffix: string): string {
  return join(cacheRoot, "resolved", `${skills.join("-")}-${suffix.replaceAll(":", "_")}`);
}

```

Add `resolveNexusSkillCatalogRoot()`:

```ts
export async function resolveNexusSkillCatalogRoot(
  opts: ResolveNexusSkillCatalogRootOptions,
): Promise<ResolvedSkillCatalogRoot> {
  const warnings: SkillResolutionWarning[] = [];
  try {
    if (opts.trustedKeys.length === 0) {
      throw new SkillCatalogTrustError("No trusted skill catalog keys configured");
    }
    const indexBytes = await opts.client.read(skillCatalogIndexPath(opts.zoneId));
    const signatureBytes = await opts.client.read(skillCatalogSignaturePath(opts.zoneId));
    if (indexBytes === undefined || signatureBytes === undefined) {
      throw new SkillCatalogUnavailableError("Nexus skill catalog index or signature is missing");
    }

    const index = parseSkillCatalogIndex(decoder.decode(indexBytes));
    const signature = parseSkillCatalogSignature(decoder.decode(signatureBytes));
    const verified = verifyCatalogSignature({ indexBytes, signature, trustedKeys: opts.trustedKeys });
    const targetRoot = resolvedRoot(opts.cacheRoot, opts.skills, verified.keyId);
    await mkdir(targetRoot, { recursive: true });

    for (const skillName of opts.skills) {
      const entry = index.skills[skillName];
      if (entry === undefined) {
        throw new SkillCatalogUnavailableError(`Nexus skill catalog missing skill '${skillName}'`);
      }
      const skillCacheDir = cacheSkillDir(opts.cacheRoot, skillName, entry.version, entry.bundleHash);
      if (!existsSync(join(skillCacheDir, "SKILL.md"))) {
        const bundleBytes = await opts.client.read(skillCatalogBundlePath(opts.zoneId, entry.bundleHash));
        if (bundleBytes === undefined) {
          throw new SkillCatalogUnavailableError(`Nexus skill bundle missing for '${skillName}'`);
        }
        verifyBundleHash(bundleBytes, entry.bundleHash);
        await unpackSkillBundle(bundleBytes, skillCacheDir);
      }
      await cp(skillCacheDir, join(targetRoot, skillName), { recursive: true, force: true });
    }

    await mkdir(opts.cacheRoot, { recursive: true });
    await writeFile(join(opts.cacheRoot, "index.json"), indexBytes);
    await writeFile(join(opts.cacheRoot, "index.sig"), signatureBytes);
    return { root: targetRoot, source: "nexus", warnings };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (opts.policy === "required") throw err;
    for (const skillName of opts.skills) {
      warnings.push({ skillName, attemptedSource: "nexus", reason });
    }
  }

  const cached = await tryVerifiedCache(opts);
  if (cached !== undefined) return { ...cached, warnings };

  const local = await tryLocalFallback(opts);
  if (local !== undefined) return { ...local, warnings };

  throw new SkillCatalogUnavailableError(
    `Unable to resolve skills from Nexus, verified cache, or local fallback: ${opts.skills.join(", ")}`,
  );
}
```

Add cache/local helper implementations. Keep them small and deterministic:

```ts
async function tryVerifiedCache(
  opts: ResolveNexusSkillCatalogRootOptions,
): Promise<Omit<ResolvedSkillCatalogRoot, "warnings"> | undefined> {
  const indexPath = join(opts.cacheRoot, "index.json");
  const sigPath = join(opts.cacheRoot, "index.sig");
  if (!existsSync(indexPath) || !existsSync(sigPath)) return undefined;
  const indexBytes = await readFile(indexPath);
  const signatureBytes = await readFile(sigPath);
  const index = parseSkillCatalogIndex(decoder.decode(indexBytes));
  const signature = parseSkillCatalogSignature(decoder.decode(signatureBytes));
  const verified = verifyCatalogSignature({ indexBytes, signature, trustedKeys: opts.trustedKeys });
  const targetRoot = resolvedRoot(opts.cacheRoot, opts.skills, `cache-${verified.keyId}`);
  await mkdir(targetRoot, { recursive: true });

  for (const skillName of opts.skills) {
    const entry = index.skills[skillName];
    if (entry === undefined) return undefined;
    const skillCacheDir = cacheSkillDir(opts.cacheRoot, skillName, entry.version, entry.bundleHash);
    if (!existsSync(join(skillCacheDir, "SKILL.md"))) return undefined;
    await cp(skillCacheDir, join(targetRoot, skillName), { recursive: true, force: true });
  }
  return { root: targetRoot, source: "cache" };
}

async function tryLocalFallback(
  opts: ResolveNexusSkillCatalogRootOptions,
): Promise<Omit<ResolvedSkillCatalogRoot, "warnings"> | undefined> {
  const targetRoot = resolvedRoot(opts.cacheRoot, opts.skills, "local");
  await mkdir(targetRoot, { recursive: true });
  for (const skillName of opts.skills) {
    const foundRoot = opts.localFallbackRoots.find((root) =>
      existsSync(join(root, skillName, "SKILL.md")),
    );
    if (foundRoot === undefined) return undefined;
    await cp(join(foundRoot, skillName), join(targetRoot, skillName), {
      recursive: true,
      force: true,
    });
  }
  return { root: targetRoot, source: "local" };
}
```

- [ ] **Step 5: Export the Nexus resolver**

In `src/nexus/index.ts`, add:

```ts
export type {
  ResolvedSkillCatalogRoot,
  ResolveNexusSkillCatalogRootOptions,
  SkillResolutionWarning,
} from "./nexus-skill-catalog.js";
export {
  resolveNexusSkillCatalogRoot,
  writeSkillCatalogToNexusForTest,
} from "./nexus-skill-catalog.js";
```

- [ ] **Step 6: Run tests**

Run:

```bash
bun test src/nexus/nexus-skill-catalog.test.ts src/core/skill-catalog.test.ts src/shared/zip.test.ts
bun run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/nexus/nexus-skill-catalog.ts src/nexus/nexus-skill-catalog.test.ts src/nexus/index.ts
git commit -m "feat(nexus): resolve signed skill catalogs"
```

## Task 5: Bootstrap resolver dependency

**Files:**
- Modify: `src/core/workspace-bootstrap.ts`
- Modify: `src/core/workspace-bootstrap.test.ts`

- [ ] **Step 1: Write failing bootstrap resolver tests**

Add this test to `src/core/workspace-bootstrap.test.ts`:

```ts
  test("injects skills from resolver-provided catalog root before local fallback", async () => {
    const remoteRoot = mkdtempSync(join(tmpdir(), "grove-remote-skills-"));
    const skillDir = join(remoteRoot, "grove");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "remote-grove", "utf-8");

    const bundledRoot = mkdtempSync(join(tmpdir(), "grove-bundled-"));
    const bundledSkillDir = join(bundledRoot, "grove");
    mkdirSync(bundledSkillDir, { recursive: true });
    writeFileSync(join(bundledSkillDir, "SKILL.md"), "bundled-grove", "utf-8");

    await bootstrapWorkspace({
      workspacePath: workspaceDir,
      roleId: "coder",
      goal: "Build",
      skills: ["grove"],
      bundledSkillsRoot: bundledRoot,
      skillCatalogResolver: async (skills) => ({
        root: remoteRoot,
        warnings: skills.map((skillName) => ({
          skillName,
          attemptedSource: "nexus",
          fallbackSource: undefined,
          reason: "verified",
        })),
      }),
    });

    expect(readFileSync(join(workspaceDir, ".claude/skills/grove/SKILL.md"), "utf-8")).toBe(
      "remote-grove",
    );

    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(bundledRoot, { recursive: true, force: true });
  });

  test("falls back to local injection when resolver returns undefined", async () => {
    const bundledRoot = mkdtempSync(join(tmpdir(), "grove-bundled-"));
    const skillDir = join(bundledRoot, "grove");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "bundled-grove", "utf-8");

    await bootstrapWorkspace({
      workspacePath: workspaceDir,
      roleId: "coder",
      goal: "Build",
      skills: ["grove"],
      bundledSkillsRoot: bundledRoot,
      skillCatalogResolver: async () => undefined,
    });

    expect(readFileSync(join(workspaceDir, ".claude/skills/grove/SKILL.md"), "utf-8")).toBe(
      "bundled-grove",
    );

    rmSync(bundledRoot, { recursive: true, force: true });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun test src/core/workspace-bootstrap.test.ts -t "resolver"
```

Expected: FAIL because `skillCatalogResolver` is not part of `BootstrapOptions`.

- [ ] **Step 3: Add resolver types to workspace bootstrap**

In `src/core/workspace-bootstrap.ts`, add these interfaces near `BootstrapOptions`:

```ts
export interface SkillCatalogResolverWarning {
  readonly skillName: string;
  readonly attemptedSource: string;
  readonly fallbackSource?: string | undefined;
  readonly reason: string;
}

export interface SkillCatalogResolverResult {
  readonly root: string;
  readonly warnings?: readonly SkillCatalogResolverWarning[] | undefined;
}

export type SkillCatalogResolver = (
  skills: readonly string[],
) => Promise<SkillCatalogResolverResult | undefined>;
```

Add this option to `BootstrapOptions`:

```ts
  /** Optional mode-aware resolver. When it returns a root, injection uses that root. */
  skillCatalogResolver?: SkillCatalogResolver | undefined;
```

- [ ] **Step 4: Use resolver before current local injection**

Replace the existing skill injection block in `bootstrapWorkspace()` with:

```ts
  if (opts.skills && opts.skills.length > 0) {
    const resolved = opts.skillCatalogResolver
      ? await opts.skillCatalogResolver(opts.skills)
      : undefined;
    const injectionRoot = resolved?.root ?? opts.bundledSkillsRoot;
    if (!injectionRoot) {
      throw new Error(
        "bootstrapWorkspace: `skills` non-empty requires `bundledSkillsRoot` or `skillCatalogResolver`.",
      );
    }
    await injectSkills({
      workspacePath: workspacePath,
      skills: opts.skills,
      bundledSkillsRoot: injectionRoot,
      workspaceOverrideRoot: resolved ? undefined : opts.workspaceOverrideRoot,
    });
  }
```

- [ ] **Step 5: Run bootstrap tests**

Run:

```bash
bun test src/core/workspace-bootstrap.test.ts src/core/skill-injector.test.ts
bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/workspace-bootstrap.ts src/core/workspace-bootstrap.test.ts
git commit -m "feat(skills): allow bootstrap skill catalog resolver"
```

## Task 6: Wire Nexus mode into SessionOrchestrator and SpawnManager

**Files:**
- Modify: `src/core/session-orchestrator.ts`
- Modify: `src/tui/spawn-manager.ts`

- [ ] **Step 1: Add a small resolver factory helper inside SessionOrchestrator**

In `src/core/session-orchestrator.ts`, import:

```ts
import { existsSync, readFileSync } from "node:fs";
import { NexusHttpClient } from "../nexus/nexus-http-client.js";
import { resolveNexusSkillCatalogRoot } from "../nexus/nexus-skill-catalog.js";
import { parseGroveConfig } from "./config.js";
import type { SkillCatalogResolver } from "./workspace-bootstrap.js";
```

Add this private method inside `SessionOrchestrator`:

```ts
  private createSkillCatalogResolver(): SkillCatalogResolver | undefined {
    const nexusUrl = process.env.GROVE_NEXUS_URL;
    if (!nexusUrl) return undefined;
    const groveDir = join(this.config.projectRoot, ".grove");
    const configPath = join(groveDir, "grove.json");
    if (!existsSync(configPath)) return undefined;
    const config = parseGroveConfig(readFileSync(configPath, "utf-8"));
    const skillCatalog = config.skillCatalog;
    if (config.mode !== "nexus" || skillCatalog === undefined) return undefined;

    const client = new NexusHttpClient({
      url: nexusUrl,
      apiKey: process.env.NEXUS_API_KEY || undefined,
    });
    const zoneId = process.env.GROVE_ZONE_ID ?? "default";
    const cacheRoot = join(groveDir, "cache", "skills");
    const bundledRoot = resolveBundledSkillsRoot(this.config.projectRoot);
    const overrideRoot = join(groveDir, "skills");

    return async (skills) => {
      const result = await resolveNexusSkillCatalogRoot({
        client,
        zoneId,
        cacheRoot,
        skills,
        policy: skillCatalog.policy,
        trustedKeys: skillCatalog.trustedKeys,
        localFallbackRoots: [overrideRoot, bundledRoot],
      });
      return { root: result.root, warnings: result.warnings };
    };
  }
```

This first pass uses `GROVE_ZONE_ID ?? "default"` to match current MCP/server env behavior when no namespace has been supplied.

- [ ] **Step 2: Pass resolver into `bootstrapWorkspace()`**

In `provisionAgentWorkspace()`, before `bootstrapWorkspace()`, add:

```ts
      const skillCatalogResolver = this.createSkillCatalogResolver();
```

Pass it in the options object:

```ts
        skillCatalogResolver,
```

- [ ] **Step 3: Mirror the resolver in SpawnManager**

In `src/tui/spawn-manager.ts`, import:

```ts
import { NexusHttpClient } from "../nexus/nexus-http-client.js";
import { resolveNexusSkillCatalogRoot } from "../nexus/nexus-skill-catalog.js";
import { parseGroveConfig } from "../core/config.js";
```

Add this private method:

```ts
  private async resolveSkillRootForSpawn(roleSkills: readonly string[]): Promise<string | undefined> {
    if (roleSkills.length === 0 || !this.groveDir) return undefined;
    const configPath = join(this.groveDir, "grove.json");
    if (!existsSync(configPath)) return undefined;
    const raw = await readFile(configPath, "utf-8");
    const config = parseGroveConfig(raw);
    if (config.mode !== "nexus" || config.skillCatalog === undefined) return undefined;

    const nexusUrl = process.env.GROVE_NEXUS_URL ?? config.nexusUrl;
    if (!nexusUrl) return undefined;
    const client = new NexusHttpClient({
      url: nexusUrl,
      apiKey: process.env.NEXUS_API_KEY || undefined,
    });
    const projectRoot = dirname(this.groveDir);
    const result = await resolveNexusSkillCatalogRoot({
      client,
      zoneId: process.env.GROVE_ZONE_ID ?? "default",
      cacheRoot: join(this.groveDir, "cache", "skills"),
      skills: roleSkills,
      policy: config.skillCatalog.policy,
      trustedKeys: config.skillCatalog.trustedKeys,
      localFallbackRoots: [join(this.groveDir, "skills"), resolveBundledSkillsRoot(projectRoot)],
    });
    return result.root;
  }
```

Update the existing TUI skill injection block:

```ts
        const roleSkills = Array.isArray(context?.skills)
          ? (context.skills as readonly string[])
          : [];
        if (roleSkills.length > 0 && this.groveDir) {
          const resolvedSkillRoot = await this.resolveSkillRootForSpawn(roleSkills);
          await injectSkills({
            workspacePath,
            skills: roleSkills,
            bundledSkillsRoot: resolvedSkillRoot ?? resolveBundledSkillsRoot(dirname(this.groveDir)),
            workspaceOverrideRoot: resolvedSkillRoot ? undefined : join(this.groveDir, "skills"),
          });
        }
```

- [ ] **Step 4: Run focused runtime tests**

Run:

```bash
bun test src/core/workspace-bootstrap.test.ts src/nexus/nexus-skill-catalog.test.ts
bun test src/tui/spawn-manager.test.ts -t "skill injection"
bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/session-orchestrator.ts src/tui/spawn-manager.ts
git commit -m "feat(runtime): resolve Nexus-hosted skills during spawn"
```

## Task 7: Full verification and child issue handoff

**Files:**
- Modify: `docs/superpowers/specs/2026-05-07-nexus-hosted-skill-distribution-design.md`

- [ ] **Step 1: Update spec status**

Change the status line in the spec to:

```markdown
- **Status:** Runtime implementation planned; publish CLI remains a child issue
```

- [ ] **Step 2: Run full verification**

Run:

```bash
bun test src/shared/zip.test.ts src/core/skill-catalog.test.ts src/nexus/nexus-skill-catalog.test.ts src/core/workspace-bootstrap.test.ts src/core/config.test.ts src/nexus/vfs-paths.test.ts
bun run typecheck
bun run check
```

Expected: all commands exit 0.

- [ ] **Step 3: Inspect changed files**

Run:

```bash
git status --short
git diff --stat
```

Expected: only the files from this plan are changed.

- [ ] **Step 4: Commit final docs/status update**

```bash
git add docs/superpowers/specs/2026-05-07-nexus-hosted-skill-distribution-design.md
git commit -m "docs(skills): mark Nexus skill runtime plan ready"
```

## Execution Notes

- Keep commits exactly at task boundaries so review can isolate config, ZIP, catalog core, Nexus adapter, runtime wiring, and final documentation.
- Do not change existing local skill injection semantics in non-Nexus mode.
- Do not log Nexus API keys, bearer tokens, or local credential file contents in warning messages.
- If `bun` is unavailable in the execution environment, stop before implementation and fix the runtime PATH; this repository requires Bun 1.3.x.
