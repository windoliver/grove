import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfig } from "./config.js";

describe("parseConfig", () => {
  test("returns defaults for empty object", () => {
    const config = parseConfig({});
    expect(config.strategy).toBe("llm");
    expect(config.fallback).toBe("rules");
    expect(config.llm.model).toBe("claude-haiku-4-5-20251001");
    expect(config.llm.timeoutMs).toBe(30_000);
    expect(config.llm.maxTokens).toBe(256);
    expect(config.rules.prefer).toBe("simpler");
    expect(config.agent.command).toBe("acpx");
  });

  test("overrides specific fields", () => {
    const config = parseConfig({
      strategy: "rules",
      llm: { model: "claude-sonnet-4-5-20250514" },
    });
    expect(config.strategy).toBe("rules");
    expect(config.llm.model).toBe("claude-sonnet-4-5-20250514");
    // Other llm defaults still apply
    expect(config.llm.timeoutMs).toBe(30_000);
  });

  test("rejects unknown strategy name", () => {
    expect(() => parseConfig({ strategy: "unknown" })).toThrow();
  });

  test("rejects negative timeoutMs", () => {
    expect(() => parseConfig({ llm: { timeoutMs: -1 } })).toThrow();
  });

  test("rejects non-integer timeoutMs", () => {
    expect(() => parseConfig({ llm: { timeoutMs: 1.5 } })).toThrow();
  });

  test("accepts all valid strategy names", () => {
    for (const s of ["llm", "rules", "agent", "interactive"] as const) {
      const config = parseConfig({ strategy: s });
      expect(config.strategy).toBe(s);
    }
  });

  test("accepts all valid prefer values", () => {
    for (const p of ["simpler", "existing", "first"] as const) {
      const config = parseConfig({ rules: { prefer: p } });
      expect(config.rules.prefer).toBe(p);
    }
  });

  test("rejects unknown top-level keys (typo detection)", () => {
    expect(() => parseConfig({ fallbak: "rules" })).toThrow();
    expect(() => parseConfig({ strateggy: "llm" })).toThrow();
  });

  test("rejects unknown keys in llm config", () => {
    expect(() => parseConfig({ llm: { maxTokenz: 1 } })).toThrow();
    expect(() => parseConfig({ llm: { timeoutMS: 5000 } })).toThrow();
  });

  test("rejects unknown keys in rules config", () => {
    expect(() => parseConfig({ rules: { perfer: "first" } })).toThrow();
  });

  test("rejects unknown keys in agent config", () => {
    expect(() => parseConfig({ agent: { commnad: "acpx" } })).toThrow();
  });
});

describe("loadConfig", () => {
  const testDir = join(tmpdir(), `ask-user-config-test-${Date.now()}`);
  const originalEnv = process.env.GROVE_ASK_USER_CONFIG;

  beforeEach(() => {
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.GROVE_ASK_USER_CONFIG;
    } else {
      process.env.GROVE_ASK_USER_CONFIG = originalEnv;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  test("returns defaults when env var is not set", () => {
    delete process.env.GROVE_ASK_USER_CONFIG;
    const config = loadConfig();
    expect(config.strategy).toBe("llm");
  });

  test("loads from config file", () => {
    const configPath = join(testDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ strategy: "rules" }));
    process.env.GROVE_ASK_USER_CONFIG = configPath;
    const config = loadConfig();
    expect(config.strategy).toBe("rules");
  });

  test("throws on invalid JSON", () => {
    const configPath = join(testDir, "bad.json");
    writeFileSync(configPath, "not json");
    process.env.GROVE_ASK_USER_CONFIG = configPath;
    expect(() => loadConfig()).toThrow();
  });

  test("throws on missing config file", () => {
    process.env.GROVE_ASK_USER_CONFIG = join(testDir, "missing.json");
    expect(() => loadConfig()).toThrow();
  });
});
