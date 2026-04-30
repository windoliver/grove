import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("package build metadata", () => {
  test("tsup builds every advertised MCP export and binary", () => {
    const root = process.cwd();
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
      exports: Record<string, { import: string; types: string }>;
      bin: Record<string, string>;
    };
    const tsupConfig = readFileSync(join(root, "tsup.config.ts"), "utf-8");

    expect(pkg.exports["./mcp"]?.import).toBe("./dist/mcp/index.js");
    expect(pkg.exports["./mcp"]?.types).toBe("./dist/mcp/index.d.ts");
    expect(pkg.bin["grove-mcp"]).toBe("./dist/mcp/serve.js");
    expect(pkg.bin["grove-mcp-http"]).toBe("./dist/mcp/serve-http.js");

    expect(tsupConfig).toContain('"src/mcp/index.ts"');
    expect(tsupConfig).toContain('"src/mcp/serve.ts"');
    expect(tsupConfig).toContain('"src/mcp/serve-http.ts"');
    expect(tsupConfig).toContain('"dist/mcp/serve.js"');
    expect(tsupConfig).toContain('"dist/mcp/serve-http.js"');
  });
});
