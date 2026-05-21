import { afterEach, describe, expect, test } from "bun:test";
import { isAbsolute } from "node:path";
import { resolveBundledSkillsRoot, resolveMcpServePath } from "./resolve-mcp-serve-path.js";

const originalArgv1 = process.argv[1];

afterEach(() => {
  if (originalArgv1 === undefined) {
    process.argv.splice(1, 1);
  } else {
    process.argv[1] = originalArgv1;
  }
});

describe("resolveMcpServePath", () => {
  test("returns an absolute path when the launcher argv is relative", () => {
    process.argv[1] = "src/cli/main.ts";

    expect(isAbsolute(resolveMcpServePath(process.cwd()))).toBe(true);
  });

  test("returns an absolute path when the launcher argv is absent", () => {
    process.argv.splice(1, 1);

    expect(isAbsolute(resolveMcpServePath(process.cwd()))).toBe(true);
  });
});

describe("resolveBundledSkillsRoot", () => {
  test("returns an absolute path when the launcher argv is relative", () => {
    process.argv[1] = "src/cli/main.ts";

    expect(isAbsolute(resolveBundledSkillsRoot(process.cwd()))).toBe(true);
  });

  test("returns an absolute path when the launcher argv is absent", () => {
    process.argv.splice(1, 1);

    expect(isAbsolute(resolveBundledSkillsRoot(process.cwd()))).toBe(true);
  });
});
