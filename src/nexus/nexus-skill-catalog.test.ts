import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { hash } from "blake3";

import { canonicalJson } from "../core/skill-catalog.js";
import { createStoredZip } from "../shared/zip.js";
import { MockNexusClient } from "./mock-client.js";
import {
  resolveNexusSkillCatalogRoot,
  writeSkillCatalogToNexusForTest,
} from "./nexus-skill-catalog.js";
import { skillCatalogBundlePath } from "./vfs-paths.js";

const encoder = new TextEncoder();

function signingFixture(): {
  readonly keyId: string;
  readonly publicKeySpkiDer: string;
  readonly privateKey: KeyObject;
} {
  const pair = generateKeyPairSync("ed25519");
  return {
    keyId: "root-key",
    publicKeySpkiDer: Buffer.from(pair.publicKey.export({ format: "der", type: "spki" })).toString(
      "base64",
    ),
    privateKey: pair.privateKey,
  };
}

async function seedNexus(opts: {
  readonly client: MockNexusClient;
  readonly zoneId: string;
  readonly privateKey: KeyObject;
  readonly keyId: string;
  readonly skillContent?: string;
  readonly version?: string;
}): Promise<{ readonly bundleHash: string }> {
  const bundle = createStoredZip([
    {
      path: "SKILL.md",
      bytes: encoder.encode(opts.skillContent ?? "nexus-skill"),
    },
  ]);
  const bundleHash = `blake3:${hash(bundle).toString("hex")}`;
  const index = {
    schemaVersion: 1,
    generatedAt: "2026-05-07T00:00:00Z",
    skills: {
      grove: { version: opts.version ?? "1", bundleHash, sizeBytes: bundle.byteLength },
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
  return { bundleHash };
}

async function seedNexusSkills(opts: {
  readonly client: MockNexusClient;
  readonly zoneId: string;
  readonly privateKey: KeyObject;
  readonly keyId: string;
  readonly skills: readonly {
    readonly name: string;
    readonly version?: string;
    readonly skillContent: string;
  }[];
}): Promise<void> {
  const bundles = opts.skills.map((skill) => {
    const bundle = createStoredZip([
      {
        path: "SKILL.md",
        bytes: encoder.encode(skill.skillContent),
      },
    ]);
    return {
      ...skill,
      bundle,
      bundleHash: `blake3:${hash(bundle).toString("hex")}`,
    };
  });
  const skills: Record<
    string,
    { readonly version: string; readonly bundleHash: string; readonly sizeBytes: number }
  > = {};
  for (const bundle of bundles) {
    skills[bundle.name] = {
      version: bundle.version ?? "1",
      bundleHash: bundle.bundleHash,
      sizeBytes: bundle.bundle.byteLength,
    };
  }
  const indexBytes = encoder.encode(
    canonicalJson({
      schemaVersion: 1,
      generatedAt: "2026-05-07T00:00:00Z",
      skills,
    }),
  );
  const signature = {
    schemaVersion: 1,
    keyId: opts.keyId,
    algorithm: "ed25519" as const,
    signature: sign(null, indexBytes, opts.privateKey).toString("base64"),
  };
  for (const bundle of bundles) {
    await writeSkillCatalogToNexusForTest({
      client: opts.client,
      zoneId: opts.zoneId,
      indexBytes,
      signatureBytes: encoder.encode(JSON.stringify(signature)),
      bundleHash: bundle.bundleHash,
      bundleBytes: bundle.bundle,
    });
  }
}

function findCachedSkillFile(cacheRoot: string): string {
  const pending = [join(cacheRoot, "unpacked")];
  for (const current of pending) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        return path;
      }
    }
  }
  throw new Error("cached SKILL.md was not found");
}

function cachedMarkerPath(cacheRoot: string): string {
  return join(dirname(findCachedSkillFile(cacheRoot)), ".grove-skill-bundle.json");
}

describe("resolveNexusSkillCatalogRoot", () => {
  test("fetches signed Nexus catalog and materializes requested skill root", async () => {
    const root = mkdtempSync(join(tmpdir(), "grove-nexus-skills-"));
    const client = new MockNexusClient();
    const keys = signingFixture();
    try {
      await seedNexus({
        client,
        zoneId: "zone1",
        privateKey: keys.privateKey,
        keyId: keys.keyId,
      });
      const result = await resolveNexusSkillCatalogRoot({
        client,
        zoneId: "zone1",
        cacheRoot: join(root, ".grove", "cache", "skills"),
        skills: ["grove"],
        policy: "warn-and-fallback",
        trustedKeys: [
          {
            id: keys.keyId,
            algorithm: "ed25519",
            publicKeySpkiDer: keys.publicKeySpkiDer,
          },
        ],
        localFallbackRoots: [],
      });

      expect(result.source).toBe("nexus");
      expect(readFileSync(join(result.root, "grove", "SKILL.md"), "utf-8")).toBe("nexus-skill");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("materializes multiple skills without exceeding resolved-root filename limits", async () => {
    const root = mkdtempSync(join(tmpdir(), "grove-nexus-skills-"));
    const client = new MockNexusClient();
    const keys = signingFixture();
    try {
      await seedNexusSkills({
        client,
        zoneId: "zone1",
        privateKey: keys.privateKey,
        keyId: keys.keyId,
        skills: [
          { name: "grove", skillContent: "grove-skill" },
          { name: "cedar", skillContent: "cedar-skill" },
        ],
      });
      const result = await resolveNexusSkillCatalogRoot({
        client,
        zoneId: "zone1",
        cacheRoot: join(root, ".grove", "cache", "skills"),
        skills: ["grove", "cedar"],
        policy: "warn-and-fallback",
        trustedKeys: [
          {
            id: keys.keyId,
            algorithm: "ed25519",
            publicKeySpkiDer: keys.publicKeySpkiDer,
          },
        ],
        localFallbackRoots: [],
      });

      expect(result.source).toBe("nexus");
      expect(readFileSync(join(result.root, "grove", "SKILL.md"), "utf-8")).toBe("grove-skill");
      expect(readFileSync(join(result.root, "cedar", "SKILL.md"), "utf-8")).toBe("cedar-skill");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps catalog version path traversal inside cache root", async () => {
    const root = mkdtempSync(join(tmpdir(), "grove-nexus-skills-"));
    const client = new MockNexusClient();
    const keys = signingFixture();
    try {
      const cacheRoot = join(root, ".grove", "cache", "skills");
      await seedNexus({
        client,
        zoneId: "zone1",
        privateKey: keys.privateKey,
        keyId: keys.keyId,
        version: "../../../../outside",
      });
      const result = await resolveNexusSkillCatalogRoot({
        client,
        zoneId: "zone1",
        cacheRoot,
        skills: ["grove"],
        policy: "warn-and-fallback",
        trustedKeys: [
          {
            id: keys.keyId,
            algorithm: "ed25519",
            publicKeySpkiDer: keys.publicKeySpkiDer,
          },
        ],
        localFallbackRoots: [],
      });
      const relativeRoot = relative(cacheRoot, result.root);

      expect(relativeRoot.startsWith("..")).toBe(false);
      expect(isAbsolute(relativeRoot)).toBe(false);
      expect(existsSync(join(root, ".grove", "outside"))).toBe(false);
      expect(readFileSync(join(result.root, "grove", "SKILL.md"), "utf-8")).toBe("nexus-skill");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("repairs tampered unpacked cache while Nexus is available", async () => {
    const root = mkdtempSync(join(tmpdir(), "grove-nexus-skills-"));
    const client = new MockNexusClient();
    const keys = signingFixture();
    try {
      const cacheRoot = join(root, ".grove", "cache", "skills");
      await seedNexus({
        client,
        zoneId: "zone1",
        privateKey: keys.privateKey,
        keyId: keys.keyId,
      });
      await resolveNexusSkillCatalogRoot({
        client,
        zoneId: "zone1",
        cacheRoot,
        skills: ["grove"],
        policy: "warn-and-fallback",
        trustedKeys: [
          {
            id: keys.keyId,
            algorithm: "ed25519",
            publicKeySpkiDer: keys.publicKeySpkiDer,
          },
        ],
        localFallbackRoots: [],
      });
      writeFileSync(findCachedSkillFile(cacheRoot), "tampered", "utf-8");

      const result = await resolveNexusSkillCatalogRoot({
        client,
        zoneId: "zone1",
        cacheRoot,
        skills: ["grove"],
        policy: "warn-and-fallback",
        trustedKeys: [
          {
            id: keys.keyId,
            algorithm: "ed25519",
            publicKeySpkiDer: keys.publicKeySpkiDer,
          },
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
      await seedNexus({
        client,
        zoneId: "zone1",
        privateKey: keys.privateKey,
        keyId: keys.keyId,
      });
      const base = {
        client,
        zoneId: "zone1",
        cacheRoot: join(root, ".grove", "cache", "skills"),
        skills: ["grove"],
        policy: "warn-and-fallback" as const,
        trustedKeys: [
          {
            id: keys.keyId,
            algorithm: "ed25519" as const,
            publicKeySpkiDer: keys.publicKeySpkiDer,
          },
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

  test("cache fallback restores missing marker from verified bundle", async () => {
    const root = mkdtempSync(join(tmpdir(), "grove-nexus-skills-"));
    const client = new MockNexusClient();
    const keys = signingFixture();
    try {
      const cacheRoot = join(root, ".grove", "cache", "skills");
      await seedNexus({
        client,
        zoneId: "zone1",
        privateKey: keys.privateKey,
        keyId: keys.keyId,
      });
      const base = {
        client,
        zoneId: "zone1",
        cacheRoot,
        skills: ["grove"],
        policy: "warn-and-fallback" as const,
        trustedKeys: [
          {
            id: keys.keyId,
            algorithm: "ed25519" as const,
            publicKeySpkiDer: keys.publicKeySpkiDer,
          },
        ],
        localFallbackRoots: [join(root, "local")],
      };
      await resolveNexusSkillCatalogRoot(base);
      const cachedSkillFile = findCachedSkillFile(cacheRoot);
      writeFileSync(cachedSkillFile, "tampered", "utf-8");
      rmSync(join(dirname(cachedSkillFile), ".grove-skill-bundle.json"), { force: true });
      const localSkill = join(root, "local", "grove");
      mkdirSync(localSkill, { recursive: true });
      writeFileSync(join(localSkill, "SKILL.md"), "local-skill", "utf-8");
      client.setFailureMode({ failNext: 10, failWith: "connection" });

      const result = await resolveNexusSkillCatalogRoot(base);

      expect(result.source).toBe("cache");
      expect(readFileSync(join(result.root, "grove", "SKILL.md"), "utf-8")).toBe("nexus-skill");
      expect(existsSync(cachedMarkerPath(cacheRoot))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Nexus resolution uses local verified bundle when marker is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "grove-nexus-skills-"));
    const client = new MockNexusClient();
    const keys = signingFixture();
    try {
      const cacheRoot = join(root, ".grove", "cache", "skills");
      const seeded = await seedNexus({
        client,
        zoneId: "zone1",
        privateKey: keys.privateKey,
        keyId: keys.keyId,
      });
      const base = {
        client,
        zoneId: "zone1",
        cacheRoot,
        skills: ["grove"],
        policy: "required" as const,
        trustedKeys: [
          {
            id: keys.keyId,
            algorithm: "ed25519" as const,
            publicKeySpkiDer: keys.publicKeySpkiDer,
          },
        ],
        localFallbackRoots: [],
      };
      await resolveNexusSkillCatalogRoot(base);
      const cachedSkillFile = findCachedSkillFile(cacheRoot);
      writeFileSync(cachedSkillFile, "tampered", "utf-8");
      rmSync(join(dirname(cachedSkillFile), ".grove-skill-bundle.json"), { force: true });
      await client.delete(skillCatalogBundlePath("zone1", seeded.bundleHash));

      const result = await resolveNexusSkillCatalogRoot(base);

      expect(result.source).toBe("nexus");
      expect(readFileSync(join(result.root, "grove", "SKILL.md"), "utf-8")).toBe("nexus-skill");
      expect(existsSync(cachedMarkerPath(cacheRoot))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cache fallback ignores torn legacy catalog pair", async () => {
    const root = mkdtempSync(join(tmpdir(), "grove-nexus-skills-"));
    const client = new MockNexusClient();
    const keys = signingFixture();
    try {
      const cacheRoot = join(root, ".grove", "cache", "skills");
      await seedNexus({
        client,
        zoneId: "zone1",
        privateKey: keys.privateKey,
        keyId: keys.keyId,
      });
      const base = {
        client,
        zoneId: "zone1",
        cacheRoot,
        skills: ["grove"],
        policy: "warn-and-fallback" as const,
        trustedKeys: [
          {
            id: keys.keyId,
            algorithm: "ed25519" as const,
            publicKeySpkiDer: keys.publicKeySpkiDer,
          },
        ],
        localFallbackRoots: [],
      };
      await resolveNexusSkillCatalogRoot(base);
      writeFileSync(join(cacheRoot, "index.json"), '{"schemaVersion":1', "utf-8");
      writeFileSync(join(cacheRoot, "index.sig"), "torn-signature", "utf-8");
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

  test("redacts Nexus URLs from fallback warnings and required errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "grove-nexus-skills-"));
    const client = new MockNexusClient();
    const keys = signingFixture();
    const secretUrl = "https://user:secret@nexus.example/api/v2/files/read?token=abc#frag";
    try {
      client.read = async (_path: string): Promise<Uint8Array | undefined> => {
        throw new Error(`Failed to connect to Nexus at ${secretUrl}: boom`);
      };
      const localSkill = join(root, "local", "grove");
      mkdirSync(localSkill, { recursive: true });
      writeFileSync(join(localSkill, "SKILL.md"), "local-skill", "utf-8");
      const trustedKeys = [
        {
          id: keys.keyId,
          algorithm: "ed25519" as const,
          publicKeySpkiDer: keys.publicKeySpkiDer,
        },
      ];

      const fallback = await resolveNexusSkillCatalogRoot({
        client,
        zoneId: "zone1",
        cacheRoot: join(root, ".grove", "cache", "skills"),
        skills: ["grove"],
        policy: "warn-and-fallback",
        trustedKeys,
        localFallbackRoots: [join(root, "local")],
      });
      const warningReason = fallback.warnings[0]?.reason ?? "";

      expect(fallback.source).toBe("local");
      expect(warningReason).toContain("https://nexus.example/[redacted]");
      expect(warningReason).not.toContain("user:secret");
      expect(warningReason).not.toContain("token=abc");
      expect(warningReason).not.toContain("/api/v2/files/read");

      let requiredMessage = "";
      try {
        await resolveNexusSkillCatalogRoot({
          client,
          zoneId: "zone1",
          cacheRoot: join(root, ".grove", "cache", "required-skills"),
          skills: ["grove"],
          policy: "required",
          trustedKeys,
          localFallbackRoots: [join(root, "local")],
        });
      } catch (error) {
        requiredMessage = error instanceof Error ? error.message : String(error);
      }

      expect(requiredMessage).toContain("https://nexus.example/[redacted]");
      expect(requiredMessage).not.toContain("user:secret");
      expect(requiredMessage).not.toContain("token=abc");
      expect(requiredMessage).not.toContain("/api/v2/files/read");

      let noFallbackCauseMessage = "";
      try {
        await resolveNexusSkillCatalogRoot({
          client,
          zoneId: "zone1",
          cacheRoot: join(root, ".grove", "cache", "no-fallback-skills"),
          skills: ["grove"],
          policy: "warn-and-fallback",
          trustedKeys,
          localFallbackRoots: [],
        });
      } catch (error) {
        if (error instanceof Error && error.cause instanceof Error) {
          noFallbackCauseMessage = error.cause.message;
        }
      }

      expect(noFallbackCauseMessage).toContain("https://nexus.example/[redacted]");
      expect(noFallbackCauseMessage).not.toContain("user:secret");
      expect(noFallbackCauseMessage).not.toContain("token=abc");
      expect(noFallbackCauseMessage).not.toContain("/api/v2/files/read");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("failed local fallback copy preserves existing resolved root", async () => {
    const root = mkdtempSync(join(tmpdir(), "grove-nexus-skills-"));
    const client = new MockNexusClient();
    const localSkill = join(root, "local", "grove");
    const unreadableDir = join(localSkill, "unreadable");
    try {
      mkdirSync(localSkill, { recursive: true });
      writeFileSync(join(localSkill, "SKILL.md"), "old-local", "utf-8");
      const base = {
        client,
        zoneId: "zone1",
        cacheRoot: join(root, ".grove", "cache", "skills"),
        skills: ["grove"],
        policy: "warn-and-fallback" as const,
        trustedKeys: [],
        localFallbackRoots: [join(root, "local")],
      };
      const first = await resolveNexusSkillCatalogRoot(base);
      mkdirSync(unreadableDir, { recursive: true });
      writeFileSync(join(unreadableDir, "blocked.txt"), "blocked", "utf-8");
      chmodSync(unreadableDir, 0);

      await expect(resolveNexusSkillCatalogRoot(base)).rejects.toThrow();

      expect(readFileSync(join(first.root, "grove", "SKILL.md"), "utf-8")).toBe("old-local");
    } finally {
      if (existsSync(unreadableDir)) {
        chmodSync(unreadableDir, 0o700);
      }
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
