import { describe, expect, test } from "bun:test";

import type { RecipeExtension } from "./recipe.js";
import { resolveRecipeMcpServers } from "./recipe-extensions.js";

describe("resolveRecipeMcpServers", () => {
  test("maps a stdio: mcp extension to an mcp server with command + args", () => {
    const ext: RecipeExtension[] = [
      { type: "mcp", name: "filesystem", uri: "stdio:grove-fs-mcp --root ." },
    ];
    expect(resolveRecipeMcpServers(ext)).toEqual([
      { name: "filesystem", command: "grove-fs-mcp", args: ["--root", "."] },
    ]);
  });

  test("a stdio: extension with no args has an empty args array", () => {
    const ext: RecipeExtension[] = [{ type: "mcp", name: "gh", uri: "stdio:gh-mcp" }];
    expect(resolveRecipeMcpServers(ext)).toEqual([{ name: "gh", command: "gh-mcp", args: [] }]);
  });

  test("optional non-stdio extension is skipped, not thrown", () => {
    const ext: RecipeExtension[] = [{ type: "mcp", name: "remote", uri: "http://x" }];
    expect(resolveRecipeMcpServers(ext)).toEqual([]);
  });

  test("optional non-mcp extension is skipped", () => {
    const ext: RecipeExtension[] = [{ type: "tool", name: "linter" }];
    expect(resolveRecipeMcpServers(ext)).toEqual([]);
  });

  test("required non-stdio extension throws", () => {
    const ext: RecipeExtension[] = [
      { type: "mcp", name: "remote", uri: "http://x", required: true },
    ];
    expect(() => resolveRecipeMcpServers(ext)).toThrow(/not launchable/);
  });

  test("stdio: extension with empty command throws", () => {
    const ext: RecipeExtension[] = [{ type: "mcp", name: "bad", uri: "stdio:   " }];
    expect(() => resolveRecipeMcpServers(ext)).toThrow(/empty command/);
  });
});
