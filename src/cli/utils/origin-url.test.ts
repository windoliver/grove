import { describe, expect, test } from "bun:test";
import { normalizeOriginUrl } from "./origin-url.js";

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
