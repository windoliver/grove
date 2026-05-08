import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNexusApiKey } from "./env.js";

describe("resolveNexusApiKey", () => {
  test("prefers NEXUS_API_KEY from process env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grove-mcp-env-"));
    try {
      await writeFile(
        join(dir, ".mcp.json"),
        JSON.stringify({
          mcpServers: { grove: { env: { NEXUS_API_KEY: "from-file" } } },
        }),
      );

      expect(resolveNexusApiKey(dir, { NEXUS_API_KEY: "from-env" })).toBe("from-env");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reads NEXUS_API_KEY from workspace .mcp.json when env omits it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grove-mcp-env-"));
    try {
      await writeFile(
        join(dir, ".mcp.json"),
        JSON.stringify({
          mcpServers: { grove: { env: { NEXUS_API_KEY: "from-file" } } },
        }),
      );

      expect(resolveNexusApiKey(dir, {})).toBe("from-file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns undefined when neither env nor workspace config has a key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grove-mcp-env-"));
    try {
      await writeFile(join(dir, ".mcp.json"), "{not-json");
      expect(resolveNexusApiKey(dir, {})).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
