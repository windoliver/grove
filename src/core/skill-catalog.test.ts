import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "blake3";
import { createStoredZip } from "../shared/zip.js";
import {
  canonicalJson,
  parseSkillCatalogIndex,
  parseSkillCatalogSignature,
  SkillBundleIntegrityError,
  SkillCatalogTrustError,
  SkillCatalogUnavailableError,
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
  readonly signature: {
    readonly schemaVersion: 1;
    readonly keyId: string;
    readonly algorithm: "ed25519";
    readonly signature: string;
  };
  readonly trustedKey: {
    readonly id: string;
    readonly algorithm: "ed25519";
    readonly publicKeySpkiDer: string;
  };
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

  test("sorts objects inside arrays and rejects undefined roots", () => {
    expect(canonicalJson([{ z: 1, a: 2 }])).toBe('[{"a":2,"z":1}]');
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });

  test("sorts numeric-looking object keys lexicographically", () => {
    expect(canonicalJson({ "10": "a", "2": "b" })).toBe('{"10":"a","2":"b"}');
  });

  test("rejects non-JSON-compatible values", () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => canonicalJson({ value: undefined })).toThrow(TypeError);
    expect(() => canonicalJson({ value: () => "nope" })).toThrow(TypeError);
    expect(() => canonicalJson({ value: Symbol("nope") })).toThrow(TypeError);
    expect(() => canonicalJson(new Date("2026-05-07T00:00:00Z"))).toThrow(TypeError);
  });
});

describe("skill catalog errors", () => {
  test("set stable names", () => {
    expect(new SkillCatalogTrustError("trust").name).toBe("SkillCatalogTrustError");
    expect(new SkillCatalogUnavailableError("unavailable").name).toBe(
      "SkillCatalogUnavailableError",
    );
    expect(new SkillBundleIntegrityError("integrity").name).toBe("SkillBundleIntegrityError");
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

  test("rejects malformed signature schemas and base64", () => {
    const fixture = signedIndex();
    expect(() =>
      verifyCatalogSignature({
        indexBytes: fixture.indexBytes,
        signature: {
          ...fixture.signature,
          schemaVersion: 2,
        } as unknown as typeof fixture.signature,
        trustedKeys: [fixture.trustedKey],
      }),
    ).toThrow(SkillCatalogTrustError);

    expect(() =>
      verifyCatalogSignature({
        indexBytes: fixture.indexBytes,
        signature: { ...fixture.signature, signature: "not-base64" },
        trustedKeys: [fixture.trustedKey],
      }),
    ).toThrow(SkillCatalogTrustError);

    expect(() =>
      verifyCatalogSignature({
        indexBytes: fixture.indexBytes,
        signature: { ...fixture.signature, signature: "AB==" },
        trustedKeys: [fixture.trustedKey],
      }),
    ).toThrow("Malformed skill catalog signature");
  });

  test("rejects invalid trusted key material", () => {
    const fixture = signedIndex();
    expect(() =>
      verifyCatalogSignature({
        indexBytes: fixture.indexBytes,
        signature: fixture.signature,
        trustedKeys: [{ ...fixture.trustedKey, publicKeySpkiDer: "abcd" }],
      }),
    ).toThrow(SkillCatalogTrustError);
  });

  test("rejects trusted keys whose configured algorithm is not ed25519", () => {
    const fixture = signedIndex();
    expect(() =>
      verifyCatalogSignature({
        indexBytes: fixture.indexBytes,
        signature: fixture.signature,
        trustedKeys: [
          {
            ...fixture.trustedKey,
            algorithm: "ed448",
          } as unknown as typeof fixture.trustedKey,
        ],
      }),
    ).toThrow(SkillCatalogTrustError);
  });

  test("rejects non-ed25519 SPKI keys even when their own signature verifies", () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicKeySpkiDer = Buffer.from(
      pair.publicKey.export({ format: "der", type: "spki" }),
    ).toString("base64");
    const indexBytes = encoder.encode(canonicalJson({ schemaVersion: 1, skills: {} }));

    expect(() =>
      verifyCatalogSignature({
        indexBytes,
        signature: {
          schemaVersion: 1,
          keyId: "root-key",
          algorithm: "ed25519",
          signature: sign("sha256", indexBytes, pair.privateKey).toString("base64"),
        },
        trustedKeys: [
          {
            id: "root-key",
            algorithm: "ed25519",
            publicKeySpkiDer,
          },
        ],
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

  test("rejects invalid index JSON and schema", () => {
    expect(() => parseSkillCatalogIndex("not json")).toThrow("not valid JSON");
    expect(() =>
      parseSkillCatalogIndex(
        '{"generatedAt":"","schemaVersion":1,"skills":{"":{"bundleHash":"bad","sizeBytes":0,"version":""}}}',
      ),
    ).toThrow("Invalid skill catalog index");
  });

  test("parses and validates signature JSON", () => {
    const fixture = signedIndex();
    const raw = JSON.stringify(fixture.signature);
    expect(parseSkillCatalogSignature(raw)).toEqual(fixture.signature);
    expect(() => parseSkillCatalogSignature("not json")).toThrow("not valid JSON");
    expect(() => parseSkillCatalogSignature('{"schemaVersion":1}')).toThrow(
      "Invalid skill catalog signature",
    );
  });

  test("verifies bundle hash before unpack", () => {
    const bytes = encoder.encode("bundle");
    const bundleHash = `blake3:${hash(bytes).toString("hex")}`;
    expect(verifyBundleHash(bytes, bundleHash)).toBe(bundleHash);
    expect(() =>
      verifyBundleHash(
        bytes,
        "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    ).toThrow(SkillBundleIntegrityError);
    expect(() => verifyBundleHash(bytes, "sha256:not-blake3")).toThrow(SkillBundleIntegrityError);
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
      expect(readFileSync(join(root, "skill", "references", "guide.md"), "utf-8")).toBe("guide");
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

  test("rejects malformed bundle zips", async () => {
    const root = mkdtempSync(join(tmpdir(), "grove-skill-catalog-"));
    try {
      await expect(
        unpackSkillBundle(encoder.encode("not a zip"), join(root, "skill")),
      ).rejects.toThrow(SkillBundleIntegrityError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("successful unpack replaces stale target contents", async () => {
    const root = mkdtempSync(join(tmpdir(), "grove-skill-catalog-"));
    try {
      const target = join(root, "skill");
      mkdirSync(target);
      writeFileSync(join(target, "stale.txt"), "stale");
      const zip = createStoredZip([{ path: "SKILL.md", bytes: encoder.encode("fresh") }]);

      await unpackSkillBundle(zip, target);

      expect(readFileSync(join(target, "SKILL.md"), "utf-8")).toBe("fresh");
      expect(existsSync(join(target, "stale.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("successful unpack does not follow existing symlinks inside target", async () => {
    const root = mkdtempSync(join(tmpdir(), "grove-skill-catalog-"));
    try {
      const target = join(root, "skill");
      const outside = join(root, "outside.txt");
      mkdirSync(target);
      writeFileSync(outside, "outside");
      symlinkSync(outside, join(target, "linked.txt"));
      const zip = createStoredZip([
        { path: "SKILL.md", bytes: encoder.encode("fresh") },
        { path: "linked.txt", bytes: encoder.encode("inside") },
      ]);

      await unpackSkillBundle(zip, target);

      expect(readFileSync(outside, "utf-8")).toBe("outside");
      expect(lstatSync(join(target, "linked.txt")).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(target, "linked.txt"), "utf-8")).toBe("inside");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid bundles do not alter an existing target", async () => {
    const root = mkdtempSync(join(tmpdir(), "grove-skill-catalog-"));
    try {
      const target = join(root, "skill");
      mkdirSync(target);
      writeFileSync(join(target, "SKILL.md"), "old");
      writeFileSync(join(target, "keep.txt"), "keep");
      const zip = createStoredZip([{ path: "README.md", bytes: encoder.encode("readme") }]);

      await expect(unpackSkillBundle(zip, target)).rejects.toThrow(SkillBundleIntegrityError);

      expect(readFileSync(join(target, "SKILL.md"), "utf-8")).toBe("old");
      expect(readFileSync(join(target, "keep.txt"), "utf-8")).toBe("keep");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
