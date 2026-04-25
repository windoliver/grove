import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectOriginUrl, normalizeOriginUrl } from "./origin-url.js";

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `grove-origin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initGitRepo(dir: string): void {
  const run = (args: string[]) => spawnSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "test"]);
}

describe("normalizeOriginUrl", () => {
  const cases: Array<[string, string | null]> = [
    ["https://github.com/Foo/Bar.git", "github.com/Foo/Bar"],
    ["https://github.com/Foo/Bar", "github.com/Foo/Bar"],
    ["http://github.com/Foo/Bar", "github.com/Foo/Bar"],
    ["git@github.com:Foo/Bar.git", "github.com/Foo/Bar"],
    ["git@github.com:Foo/Bar", "github.com/Foo/Bar"],
    ["ssh://git@github.com/Foo/Bar.git", "github.com/Foo/Bar"],
    ["ssh://git@github.com:22/Foo/Bar.git", "github.com/Foo/Bar"],
    ["git://github.com/Foo/Bar", "github.com/Foo/Bar"],
    ["git+ssh://git@github.com/Foo/Bar.git", "github.com/Foo/Bar"],
    ["https://GitHub.com/foo/bar", "github.com/foo/bar"],
    ["https://github.com/ACME/Repo/", "github.com/ACME/Repo"],
    ["https://user:pass@github.com/foo/bar.git", "github.com/foo/bar"],
    ["https://x-access-token:ghp_xxx@github.com/foo/bar", "github.com/foo/bar"],
    ["https://token@github.com/foo/bar.git", "github.com/foo/bar"],
    ["", null],
    ["just-a-string", null],
    ["file:///tmp/repo", null],
  ];

  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(normalizeOriginUrl(input)).toBe(expected);
    });
  }

  test("preserves path case for GitLab-style paths", () => {
    expect(normalizeOriginUrl("https://gitlab.com/Acme/Service.git")).toBe(
      "gitlab.com/Acme/Service",
    );
  });
});

describe("detectOriginUrl", () => {
  test("returns null in a non-git directory", () => {
    const dir = makeTmpDir();
    expect(detectOriginUrl(dir)).toBeNull();
  });

  test("returns null in a git repo with no origin remote", () => {
    const dir = makeTmpDir();
    initGitRepo(dir);
    expect(detectOriginUrl(dir)).toBeNull();
  });

  test("returns the raw origin URL", () => {
    const dir = makeTmpDir();
    initGitRepo(dir);
    spawnSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:foo/bar.git"], {
      stdio: "ignore",
    });
    expect(detectOriginUrl(dir)).toBe("git@github.com:foo/bar.git");
  });
});
