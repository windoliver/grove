/**
 * Tests for workspace mutation validation against contract-defined path constraints.
 *
 * Each test creates a temporary git repo, makes changes, and validates
 * against various constraint configurations.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  validateWorkspaceMutations,
  type WorkspaceConstraints,
} from "./workspace-validator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp git repo with an initial empty commit. */
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "grove-ws-test-"));
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@grove.dev"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
  execSync("git commit --allow-empty -m 'init'", { cwd: dir, stdio: "pipe" });
  return dir;
}

/** Write a file in the repo (creates parent dirs as needed). */
function writeFile(dir: string, relativePath: string, content: string): void {
  const fullPath = join(dir, relativePath);
  const parentDir = fullPath.slice(0, fullPath.lastIndexOf("/"));
  if (parentDir !== dir) {
    mkdirSync(parentDir, { recursive: true });
  }
  writeFileSync(fullPath, content);
}

/** Stage and commit all changes. */
function commitAll(dir: string, message: string): void {
  execSync("git add -A", { cwd: dir, stdio: "pipe" });
  execSync(`git commit -m '${message}'`, { cwd: dir, stdio: "pipe" });
}

/** Stage a file (add to index). */
function stageFile(dir: string, relativePath: string): void {
  execSync(`git add "${relativePath}"`, { cwd: dir, stdio: "pipe" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateWorkspaceMutations", () => {
  let dir: string;

  beforeEach(() => {
    dir = initRepo();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // No constraints
  // -------------------------------------------------------------------------

  test("no constraints → always valid", () => {
    writeFile(dir, "anything.txt", "hello");
    stageFile(dir, "anything.txt");

    const result = validateWorkspaceMutations(dir, {});
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.stashed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // No changes
  // -------------------------------------------------------------------------

  test("no changes → valid", () => {
    const constraints: WorkspaceConstraints = {
      immutablePaths: [".grove/"],
      mutablePaths: ["src/"],
    };

    const result = validateWorkspaceMutations(dir, constraints);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.stashed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Immutable path violations
  // -------------------------------------------------------------------------

  test("immutable path modified → violation", () => {
    // Create and commit the file first so it's tracked
    writeFile(dir, ".grove/config.yaml", "initial");
    commitAll(dir, "add grove config");

    // Now modify it
    writeFile(dir, ".grove/config.yaml", "modified");
    stageFile(dir, ".grove/config.yaml");

    const result = validateWorkspaceMutations(dir, {
      immutablePaths: [".grove/"],
    });

    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.type).toBe("immutable_path");
    expect(result.violations[0]!.path).toBe(".grove/config.yaml");
  });

  test("immutable exact file modified → violation", () => {
    writeFile(dir, ".mcp.json", "{}");
    commitAll(dir, "add mcp json");

    writeFile(dir, ".mcp.json", '{"changed": true}');
    stageFile(dir, ".mcp.json");

    const result = validateWorkspaceMutations(dir, {
      immutablePaths: [".mcp.json"],
    });

    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.type).toBe("immutable_path");
    expect(result.violations[0]!.path).toBe(".mcp.json");
  });

  test("new file in immutable directory → violation", () => {
    writeFile(dir, ".grove/new-file.txt", "sneaky");
    stageFile(dir, ".grove/new-file.txt");

    const result = validateWorkspaceMutations(dir, {
      immutablePaths: [".grove/"],
    });

    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.type).toBe("immutable_path");
  });

  // -------------------------------------------------------------------------
  // Mutable path constraints
  // -------------------------------------------------------------------------

  test("mutable paths defined, file outside → violation", () => {
    writeFile(dir, "README.md", "hello");
    stageFile(dir, "README.md");

    const result = validateWorkspaceMutations(dir, {
      mutablePaths: ["src/", "tests/"],
    });

    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.type).toBe("outside_mutable");
    expect(result.violations[0]!.path).toBe("README.md");
  });

  test("mutable paths defined, file inside → valid", () => {
    writeFile(dir, "src/main.ts", "export {}");
    stageFile(dir, "src/main.ts");

    const result = validateWorkspaceMutations(dir, {
      mutablePaths: ["src/", "tests/"],
    });

    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  test("multiple files, some inside some outside mutable paths", () => {
    writeFile(dir, "src/main.ts", "export {}");
    writeFile(dir, "config.yaml", "key: value");
    stageFile(dir, "src/main.ts");
    stageFile(dir, "config.yaml");

    const result = validateWorkspaceMutations(dir, {
      mutablePaths: ["src/"],
    });

    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.type).toBe("outside_mutable");
    expect(result.violations[0]!.path).toBe("config.yaml");
  });

  // -------------------------------------------------------------------------
  // Immutable takes precedence over mutable
  // -------------------------------------------------------------------------

  test("immutable takes precedence over mutable", () => {
    writeFile(dir, "src/secret.ts", "const KEY = 'abc'");
    stageFile(dir, "src/secret.ts");

    const result = validateWorkspaceMutations(dir, {
      mutablePaths: ["src/"],
      immutablePaths: ["src/secret.ts"],
    });

    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.type).toBe("immutable_path");
    expect(result.violations[0]!.path).toBe("src/secret.ts");
  });

  // -------------------------------------------------------------------------
  // maxFileSize
  // -------------------------------------------------------------------------

  test("maxFileSize exceeded → violation", () => {
    // Write a file larger than the limit
    const bigContent = "x".repeat(1024);
    writeFile(dir, "src/big.txt", bigContent);
    stageFile(dir, "src/big.txt");

    const result = validateWorkspaceMutations(dir, {
      maxFileSize: 100,
    });

    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.type).toBe("file_too_large");
    expect(result.violations[0]!.path).toBe("src/big.txt");
    expect(result.violations[0]!.message).toContain("1024 bytes");
    expect(result.violations[0]!.message).toContain("100 bytes");
  });

  test("maxFileSize not exceeded → valid", () => {
    writeFile(dir, "src/small.txt", "tiny");
    stageFile(dir, "src/small.txt");

    const result = validateWorkspaceMutations(dir, {
      maxFileSize: 1000,
    });

    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Stash on violation
  // -------------------------------------------------------------------------

  test("stashOnViolation stashes offending files", () => {
    // Create base state
    writeFile(dir, "src/allowed.ts", "ok");
    writeFile(dir, "GROVE.md", "contract");
    commitAll(dir, "base");

    // Make changes: one allowed, one not
    writeFile(dir, "src/allowed.ts", "modified ok");
    writeFile(dir, "GROVE.md", "modified contract");
    stageFile(dir, "src/allowed.ts");
    stageFile(dir, "GROVE.md");

    const result = validateWorkspaceMutations(
      dir,
      { immutablePaths: ["GROVE.md"] },
      true,
    );

    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.stashed).toBe(true);
    expect(result.stashRef).toBeDefined();

    // Verify the immutable file was restored to its committed state
    const groveContent = execSync("git show HEAD:GROVE.md", {
      cwd: dir,
      encoding: "utf-8",
    }).trim();
    expect(groveContent).toBe("contract");

    // Verify the allowed file change is still present
    const status = execSync("git status --porcelain", {
      cwd: dir,
      encoding: "utf-8",
    }).trim();
    expect(status).toContain("src/allowed.ts");
  });

  test("stashOnViolation=false does not stash", () => {
    writeFile(dir, ".grove/config.yaml", "modified");
    stageFile(dir, ".grove/config.yaml");

    const result = validateWorkspaceMutations(
      dir,
      { immutablePaths: [".grove/"] },
      false,
    );

    expect(result.valid).toBe(false);
    expect(result.stashed).toBe(false);
    expect(result.stashRef).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Non-git directory
  // -------------------------------------------------------------------------

  test("non-git directory → valid (no violations)", () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), "grove-nongit-"));
    try {
      writeFileSync(join(nonGitDir, "file.txt"), "content");
      const result = validateWorkspaceMutations(nonGitDir, {
        immutablePaths: ["file.txt"],
      });
      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Multiple violation types
  // -------------------------------------------------------------------------

  test("multiple violation types in one validation", () => {
    writeFile(dir, ".grove/config.yaml", "immutable");
    writeFile(dir, "docs/readme.md", "outside mutable");
    const bigContent = "x".repeat(2000);
    writeFile(dir, "src/huge.bin", bigContent);
    stageFile(dir, ".grove/config.yaml");
    stageFile(dir, "docs/readme.md");
    stageFile(dir, "src/huge.bin");

    const result = validateWorkspaceMutations(dir, {
      mutablePaths: ["src/"],
      immutablePaths: [".grove/"],
      maxFileSize: 1000,
    });

    expect(result.valid).toBe(false);
    // .grove/config.yaml → immutable_path
    // docs/readme.md → outside_mutable
    // src/huge.bin → file_too_large
    expect(result.violations).toHaveLength(3);

    const types = result.violations.map((v) => v.type);
    expect(types).toContain("immutable_path");
    expect(types).toContain("outside_mutable");
    expect(types).toContain("file_too_large");
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  test("empty mutablePaths array allows all files", () => {
    writeFile(dir, "anywhere.txt", "content");
    stageFile(dir, "anywhere.txt");

    const result = validateWorkspaceMutations(dir, {
      mutablePaths: [],
    });

    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  test("directory prefix without trailing slash matches as prefix", () => {
    writeFile(dir, ".grove/nested/deep.txt", "data");
    stageFile(dir, ".grove/nested/deep.txt");

    const result = validateWorkspaceMutations(dir, {
      immutablePaths: [".grove"],
    });

    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.type).toBe("immutable_path");
  });

  test("unstaged changes are also detected", () => {
    writeFile(dir, "tracked.txt", "initial");
    commitAll(dir, "add tracked");

    // Modify without staging
    writeFile(dir, "tracked.txt", "modified");

    const result = validateWorkspaceMutations(dir, {
      immutablePaths: ["tracked.txt"],
    });

    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
  });
});
