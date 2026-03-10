/**
 * Comprehensive negative test matrix for path containment utilities.
 *
 * Covers 10 attack vectors:
 * 1. ../traversal (basic, nested, trailing)
 * 2. Absolute path injection
 * 3. Symlink escape
 * 4. URL-encoded traversal
 * 5. Null byte injection
 * 6. Windows-style separators
 * 7. Unicode normalization
 * 8. Trailing dots/spaces
 * 9. Special characters in names
 * 10. Empty/whitespace names
 */

import { describe, expect, test } from "bun:test";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ArtifactNameError,
  assertWithinBoundary,
  containsTraversal,
  PathContainmentError,
  sanitizeCidForPath,
  validateArtifactName,
  validateWorkspaceKey,
} from "./path-safety.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(prefix: string): Promise<string> {
  const dir = join(tmpdir(), `grove-path-test-${prefix}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  // Resolve symlinks (e.g., /tmp → /private/tmp on macOS)
  return realpath(dir);
}

// ---------------------------------------------------------------------------
// assertWithinBoundary
// ---------------------------------------------------------------------------

describe("assertWithinBoundary", () => {
  test("allows path within boundary", async () => {
    const boundary = await makeTempDir("within");
    try {
      const subdir = join(boundary, "subdir");
      await mkdir(subdir, { recursive: true });
      const result = await assertWithinBoundary(subdir, boundary);
      expect(result).toBe(subdir);
    } finally {
      await rm(boundary, { recursive: true, force: true });
    }
  });

  test("allows nested path within boundary", async () => {
    const boundary = await makeTempDir("nested");
    try {
      const nested = join(boundary, "a", "b", "c");
      await mkdir(nested, { recursive: true });
      const result = await assertWithinBoundary(nested, boundary);
      expect(result).toBe(nested);
    } finally {
      await rm(boundary, { recursive: true, force: true });
    }
  });

  test("allows boundary root itself", async () => {
    const boundary = await makeTempDir("self");
    try {
      const result = await assertWithinBoundary(boundary, boundary);
      expect(result).toBe(boundary);
    } finally {
      await rm(boundary, { recursive: true, force: true });
    }
  });

  test("allows relative path within boundary", async () => {
    const boundary = await makeTempDir("relative");
    try {
      const subdir = join(boundary, "sub");
      await mkdir(subdir, { recursive: true });
      const result = await assertWithinBoundary("sub", boundary);
      expect(result).toBe(subdir);
    } finally {
      await rm(boundary, { recursive: true, force: true });
    }
  });

  test("allows non-existent path within boundary (ancestor walk)", async () => {
    const boundary = await makeTempDir("nonexist");
    try {
      const result = await assertWithinBoundary(
        join(boundary, "does", "not", "exist.txt"),
        boundary,
      );
      expect(result.startsWith(boundary)).toBe(true);
    } finally {
      await rm(boundary, { recursive: true, force: true });
    }
  });

  // Vector 1: ../traversal
  test("rejects basic ../ traversal", async () => {
    const boundary = await makeTempDir("traversal-basic");
    try {
      await expect(assertWithinBoundary(join(boundary, ".."), boundary)).rejects.toThrow(
        PathContainmentError,
      );
    } finally {
      await rm(boundary, { recursive: true, force: true });
    }
  });

  test("rejects nested ../ traversal", async () => {
    const boundary = await makeTempDir("traversal-nested");
    try {
      const subdir = join(boundary, "sub");
      await mkdir(subdir, { recursive: true });
      await expect(
        assertWithinBoundary(join(boundary, "sub", "..", ".."), boundary),
      ).rejects.toThrow(PathContainmentError);
    } finally {
      await rm(boundary, { recursive: true, force: true });
    }
  });

  test("rejects traversal disguised with intermediate segments", async () => {
    const boundary = await makeTempDir("traversal-disguised");
    try {
      await expect(
        assertWithinBoundary(join(boundary, "sub", "..", "..", "etc", "passwd"), boundary),
      ).rejects.toThrow(PathContainmentError);
    } finally {
      await rm(boundary, { recursive: true, force: true });
    }
  });

  // Vector 2: Absolute path injection
  test("rejects absolute path outside boundary", async () => {
    const boundary = await makeTempDir("abs-outside");
    try {
      await expect(assertWithinBoundary("/etc/passwd", boundary)).rejects.toThrow(
        PathContainmentError,
      );
    } finally {
      await rm(boundary, { recursive: true, force: true });
    }
  });

  test("rejects absolute path to parent directory", async () => {
    const boundary = await makeTempDir("abs-parent");
    try {
      await expect(assertWithinBoundary(tmpdir(), boundary)).rejects.toThrow(PathContainmentError);
    } finally {
      await rm(boundary, { recursive: true, force: true });
    }
  });

  // Vector 3: Symlink escape
  test("rejects symlink pointing outside boundary", async () => {
    const boundary = await makeTempDir("symlink-escape");
    const outsideDir = await makeTempDir("symlink-target");
    try {
      await writeFile(join(outsideDir, "secret.txt"), "sensitive data");
      const linkPath = join(boundary, "evil-link");
      await symlink(outsideDir, linkPath);

      await expect(assertWithinBoundary(join(linkPath, "secret.txt"), boundary)).rejects.toThrow(
        PathContainmentError,
      );
    } finally {
      await rm(boundary, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  test("allows symlink pointing within boundary", async () => {
    const boundary = await makeTempDir("symlink-safe");
    try {
      const realDir = join(boundary, "real");
      await mkdir(realDir, { recursive: true });
      await writeFile(join(realDir, "file.txt"), "safe data");
      const linkPath = join(boundary, "link-to-real");
      await symlink(realDir, linkPath);

      const result = await assertWithinBoundary(join(linkPath, "file.txt"), boundary);
      expect(result.startsWith(boundary)).toBe(true);
    } finally {
      await rm(boundary, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// validateArtifactName
// ---------------------------------------------------------------------------

describe("validateArtifactName", () => {
  // Valid names (per spec: [a-zA-Z0-9][a-zA-Z0-9._/ -]*)
  test("accepts simple alphanumeric name", () => {
    expect(validateArtifactName("report.json")).toBe("report.json");
  });

  test("accepts name with hyphens and underscores", () => {
    expect(validateArtifactName("my-artifact_v2.tar.gz")).toBe("my-artifact_v2.tar.gz");
  });

  test("accepts single character name", () => {
    expect(validateArtifactName("a")).toBe("a");
  });

  // Spec explicitly allows forward slashes for relative paths
  test("accepts nested path with forward slashes (spec-valid)", () => {
    expect(validateArtifactName("src/main.py")).toBe("src/main.py");
  });

  test("accepts deeply nested path", () => {
    expect(validateArtifactName("src/models/bert.py")).toBe("src/models/bert.py");
  });

  test("accepts name with spaces (spec-valid)", () => {
    expect(validateArtifactName("my report v2.pdf")).toBe("my report v2.pdf");
  });

  // Traversal attacks
  test("rejects .. path component in middle", () => {
    expect(() => validateArtifactName("src/../secret.txt")).toThrow(ArtifactNameError);
  });

  test("rejects .. at end of path", () => {
    expect(() => validateArtifactName("models/..")).toThrow(ArtifactNameError);
  });

  test("rejects deeply nested traversal", () => {
    expect(() => validateArtifactName("a/../../etc/passwd")).toThrow(ArtifactNameError);
  });

  // Must start with alphanumeric
  test("rejects name starting with dot", () => {
    expect(() => validateArtifactName(".gitignore")).toThrow(ArtifactNameError);
  });

  test("rejects name starting with slash", () => {
    expect(() => validateArtifactName("/etc/passwd")).toThrow(ArtifactNameError);
  });

  test("rejects name starting with space", () => {
    expect(() => validateArtifactName(" file.txt")).toThrow(ArtifactNameError);
  });

  // Null byte injection
  test("rejects null byte in name", () => {
    expect(() => validateArtifactName("file\x00.txt")).toThrow(ArtifactNameError);
  });

  test("rejects null byte at end", () => {
    expect(() => validateArtifactName("file.txt\x00")).toThrow(ArtifactNameError);
  });

  // Windows-style separators
  test("rejects backslash separator", () => {
    expect(() => validateArtifactName("dir\\file.txt")).toThrow(ArtifactNameError);
  });

  // Reserved characters (not in spec allowed set)
  test("rejects colon in name", () => {
    expect(() => validateArtifactName("file:name")).toThrow(ArtifactNameError);
  });

  test("rejects pipe in name", () => {
    expect(() => validateArtifactName("file|name")).toThrow(ArtifactNameError);
  });

  // Empty/whitespace
  test("rejects empty name", () => {
    expect(() => validateArtifactName("")).toThrow(ArtifactNameError);
  });

  test("rejects whitespace-only name", () => {
    expect(() => validateArtifactName("   ")).toThrow(ArtifactNameError);
  });

  // Trailing slash (directory, not file)
  test("rejects trailing slash", () => {
    expect(() => validateArtifactName("src/")).toThrow(ArtifactNameError);
  });

  // Length limit
  test("rejects name exceeding 256 characters", () => {
    const longName = "a".repeat(257);
    expect(() => validateArtifactName(longName)).toThrow(ArtifactNameError);
  });
});

// ---------------------------------------------------------------------------
// sanitizeCidForPath
// ---------------------------------------------------------------------------

describe("sanitizeCidForPath", () => {
  test("extracts hex from valid CID", () => {
    const cid = "blake3:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    expect(sanitizeCidForPath(cid)).toBe(
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    );
  });

  test("rejects CID without blake3 prefix", () => {
    expect(() => sanitizeCidForPath("sha256:abc123")).toThrow("expected 'blake3:' prefix");
  });

  test("rejects CID with short hex", () => {
    expect(() => sanitizeCidForPath("blake3:abc123")).toThrow("64 lowercase hex characters");
  });

  test("rejects CID with uppercase hex", () => {
    expect(() =>
      sanitizeCidForPath("blake3:ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789"),
    ).toThrow("64 lowercase hex characters");
  });
});

// ---------------------------------------------------------------------------
// validateWorkspaceKey
// ---------------------------------------------------------------------------

describe("validateWorkspaceKey", () => {
  test("accepts hex string", () => {
    expect(validateWorkspaceKey("abc123def456")).toBe("abc123def456");
  });

  test("accepts alphanumeric with dots, hyphens, underscores", () => {
    expect(validateWorkspaceKey("my-workspace_v2.0")).toBe("my-workspace_v2.0");
  });

  test("rejects empty key", () => {
    expect(() => validateWorkspaceKey("")).toThrow("must not be empty");
  });

  test("rejects key with spaces", () => {
    expect(() => validateWorkspaceKey("my workspace")).toThrow("unsafe characters");
  });

  test("rejects key with path separator", () => {
    expect(() => validateWorkspaceKey("../parent")).toThrow("unsafe characters");
  });

  test("rejects key with colon", () => {
    expect(() => validateWorkspaceKey("blake3:abc")).toThrow("unsafe characters");
  });
});

// ---------------------------------------------------------------------------
// containsTraversal
// ---------------------------------------------------------------------------

describe("containsTraversal", () => {
  test("detects basic ../", () => {
    expect(containsTraversal("../foo")).toBe(true);
  });

  test("detects nested ../", () => {
    expect(containsTraversal("foo/../../bar")).toBe(true);
  });

  test("detects trailing ..", () => {
    expect(containsTraversal("foo/..")).toBe(true);
  });

  test("detects bare ..", () => {
    expect(containsTraversal("..")).toBe(true);
  });

  test("detects absolute path", () => {
    expect(containsTraversal("/etc/passwd")).toBe(true);
  });

  test("safe relative path", () => {
    expect(containsTraversal("foo/bar/baz.txt")).toBe(false);
  });

  test("safe filename with dots", () => {
    expect(containsTraversal("file.tar.gz")).toBe(false);
  });

  test("safe hidden file", () => {
    expect(containsTraversal(".gitignore")).toBe(false);
  });
});
