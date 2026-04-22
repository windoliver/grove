import { describe, expect, test } from "bun:test";
import { deriveCachePath, type NormalizedRepo, normalizeUrl, type RepoRef } from "./repo-ref.js";

describe("normalizeUrl", () => {
  const cases: ReadonlyArray<readonly [string, NormalizedRepo]> = [
    ["git@github.com:foo/bar.git", { host: "github.com", path: "foo/bar" }],
    ["git@github.com:foo/bar", { host: "github.com", path: "foo/bar" }],
    ["https://github.com/foo/bar", { host: "github.com", path: "foo/bar" }],
    ["https://github.com/foo/bar.git", { host: "github.com", path: "foo/bar" }],
    ["https://github.com/foo/bar/", { host: "github.com", path: "foo/bar" }],
    ["https://GitHub.com/Foo/Bar.git", { host: "github.com", path: "Foo/Bar" }],
    ["https://user@github.com/foo/bar", { host: "github.com", path: "foo/bar" }],
    ["ssh://git@gitlab.com/group/sub/p.git", { host: "gitlab.com", path: "group/sub/p" }],
    ["file:///abs/path/to/repo", { host: "local", path: "abs/path/to/repo" }],
    ["/abs/path/to/repo", { host: "local", path: "abs/path/to/repo" }],
    ["/abs/path/to/repo.git", { host: "local", path: "abs/path/to/repo" }],
  ];

  for (const [input, expected] of cases) {
    test(`"${input}" normalizes correctly`, () => {
      expect(normalizeUrl(input)).toEqual(expected);
    });
  }

  test("rejects path with `..` traversal", () => {
    expect(() => normalizeUrl("https://github.com/foo/../bar")).toThrow(/traversal/);
  });

  test("rejects path with leading-dot component", () => {
    expect(() => normalizeUrl("https://github.com/foo/.hidden/bar")).toThrow(/leading dot/);
  });

  test("rejects empty host", () => {
    expect(() => normalizeUrl("https:///foo/bar")).toThrow(/host/);
  });

  test("rejects empty path", () => {
    expect(() => normalizeUrl("https://github.com/")).toThrow(/path/);
  });

  test("rejects non-absolute local path", () => {
    expect(() => normalizeUrl("relative/path/repo")).toThrow(/absolute/);
  });

  test("rejects URL with null byte", () => {
    expect(() => normalizeUrl("https://github.com/foo/bar\x00baz")).toThrow(/null byte/);
  });

  test("rejects URL with backslash", () => {
    expect(() => normalizeUrl("https://github.com/foo\\bar")).toThrow(/backslash/);
  });

  test("rejects percent-encoded `..` traversal", () => {
    expect(() => normalizeUrl("https://github.com/foo/%2e%2e/bar")).toThrow(/traversal/);
  });

  test("rejects percent-encoded null byte", () => {
    expect(() => normalizeUrl("https://github.com/foo/bar%00baz")).toThrow(/null byte/);
  });

  test("rejects percent-encoded slash (%2F) producing empty segment or traversal", () => {
    expect(() => normalizeUrl("https://github.com/foo/%2F..%2Fetc")).toThrow(
      /empty segment|traversal/,
    );
  });

  test("rejects malformed percent-encoding", () => {
    expect(() => normalizeUrl("https://github.com/foo/%ZZ")).toThrow(/percent-encoding/);
  });

  test("rejects local path with null byte", () => {
    expect(() => normalizeUrl("/abs/path/\x00secret")).toThrow(/null byte/);
  });

  test("rejects file:// URL with backslash", () => {
    expect(() => normalizeUrl("file:///abs/path\\windows")).toThrow(/backslash/);
  });

  test("rejects double-colon SCP (git@host:port:path)", () => {
    expect(() => normalizeUrl("git@github.com:22:foo/bar")).toThrow(/colon in segment/);
  });

  test("rejects dotdot hostname (SCP)", () => {
    expect(() => normalizeUrl("git@..:foo/bar")).toThrow(/traversal in hostname/);
  });

  test("rejects dotdot hostname (HTTPS)", () => {
    expect(() => normalizeUrl("https://../foo/bar")).toThrow(/traversal in hostname/);
  });
});

describe("deriveCachePath", () => {
  test("produces host/path.git layout", () => {
    expect(deriveCachePath({ host: "github.com", path: "foo/bar" })).toBe("github.com/foo/bar.git");
  });

  test("preserves nested path segments", () => {
    expect(deriveCachePath({ host: "gitlab.com", path: "group/sub/p" })).toBe(
      "gitlab.com/group/sub/p.git",
    );
  });

  test("local namespace", () => {
    expect(deriveCachePath({ host: "local", path: "abs/path/to/repo" })).toBe(
      "local/abs/path/to/repo.git",
    );
  });
});

describe("RepoRef", () => {
  test("discriminated union compiles", () => {
    const a: RepoRef = { kind: "local", path: "/tmp/x" };
    const b: RepoRef = { kind: "url", url: "https://github.com/foo/bar" };
    const c: RepoRef = { kind: "url", url: "https://github.com/foo/bar", ref: "main" };
    expect([a.kind, b.kind, c.kind]).toEqual(["local", "url", "url"]);
  });
});
