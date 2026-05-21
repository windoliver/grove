import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TUI_MAIN_PATH = join(import.meta.dir, "main.ts");

describe("TUI MCP orphan reaper", () => {
  test("targets stdio MCP serve.ts without matching serve-http.ts", () => {
    const source = readFileSync(TUI_MAIN_PATH, "utf-8");

    expect(source).not.toContain("mcp/serve'");
    expect(source).not.toContain('mcp/serve"');
    expect(source).toContain("mcp/serve\\\\.(ts|js)");
  });
});
