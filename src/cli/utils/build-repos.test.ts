import { describe, expect, test } from "bun:test";
import { buildRepos } from "./build-repos.js";

describe("buildRepos", () => {
  test("one --repo url value → url RepoRef", () => {
    const result = buildRepos({
      rawRepo: ["https://github.com/foo/bar"],
      cwd: "/abs/cwd",
    });
    expect(result).toEqual([{ kind: "url", url: "https://github.com/foo/bar" }]);
  });

  test("one --repo absolute-path value → local RepoRef", () => {
    const result = buildRepos({
      rawRepo: ["/abs/path/to/repo"],
      cwd: "/abs/cwd",
    });
    expect(result).toEqual([{ kind: "local", path: "/abs/path/to/repo" }]);
  });

  test("one --repo relative-path value → local RepoRef", () => {
    const result = buildRepos({
      rawRepo: ["./sibling"],
      cwd: "/abs/cwd",
    });
    expect(result).toEqual([{ kind: "local", path: "./sibling" }]);
  });

  test("two --repo values → throws multi-repo", () => {
    expect(() =>
      buildRepos({
        rawRepo: ["https://github.com/foo/bar", "https://github.com/baz/qux"],
        cwd: "/abs/cwd",
      }),
    ).toThrow(/multi-repo sessions/);
  });

  test("no --repo + cwd is a git repo → local RepoRef at cwd", () => {
    const result = buildRepos({
      rawRepo: [],
      cwd: "/abs/cwd",
      isGitRepo: () => true,
    });
    expect(result).toEqual([{ kind: "local", path: "/abs/cwd" }]);
  });

  test("no --repo + cwd not a git repo → throws actionable error", () => {
    expect(() =>
      buildRepos({
        rawRepo: [],
        cwd: "/abs/not-a-repo",
        isGitRepo: () => false,
      }),
    ).toThrow(/run grove from inside a git repo/);
  });
});
