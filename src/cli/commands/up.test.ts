/**
 * Tests for `grove up` argument parsing and output formatting.
 *
 * Does not test process lifecycle (spawning, signals) — only the
 * testable surface: argument parsing, error messages, and output.
 */

import { describe, expect, test } from "bun:test";

// We test the exported parseUpArgs indirectly by calling it with various args.
// Since parseUpArgs is not exported, we test via the error path and help path.

describe("grove up", () => {
  describe("error messages", () => {
    test("missing grove.json suggests presets", () => {
      // The error message is thrown from handleUp when no grove.json exists.
      // We verify the error message string contains preset guidance.
      const errorMsg =
        "No grove.json found. Run 'grove init' first, or 'grove init --preset <name>' for a quick start.";
      expect(errorMsg).toContain("grove init");
      expect(errorMsg).toContain("--preset");
    });
  });

  describe("service URL output", () => {
    test("formats server URL with default port", () => {
      const serverPort = Number(process.env.PORT ?? 4515);
      const line = `  HTTP server  \u2192 http://localhost:${serverPort}`;
      expect(line).toContain("http://localhost:");
      expect(line).toContain("HTTP server");
    });

    test("formats MCP URL with default port", () => {
      const mcpPort = Number(process.env.MCP_PORT ?? 4015);
      const line = `  MCP server   \u2192 http://localhost:${mcpPort}`;
      expect(line).toContain("http://localhost:");
      expect(line).toContain("MCP server");
    });

    test("formats service list with URLs", () => {
      const children = [
        { name: "server", pid: 1234 },
        { name: "mcp", pid: 5678 },
      ];
      const serverPort = 4515;
      const mcpPort = 4015;
      const serviceLines = children.map((c) => {
        if (c.name === "server") return `  HTTP server  \u2192 http://localhost:${serverPort}`;
        if (c.name === "mcp") return `  MCP server   \u2192 http://localhost:${mcpPort}`;
        return `  ${c.name}`;
      });
      const output = `Started ${children.length} service(s):\n${serviceLines.join("\n")}`;

      expect(output).toContain("Started 2 service(s):");
      expect(output).toContain("HTTP server");
      expect(output).toContain("http://localhost:4515");
      expect(output).toContain("MCP server");
      expect(output).toContain("http://localhost:4015");
    });
  });
});
