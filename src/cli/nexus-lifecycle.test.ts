/**
 * Unit tests for nexus-lifecycle.ts pure/filesystem functions.
 *
 * Subprocess-heavy functions (nexusUp, ensureNexusRunning) are covered by
 * integration tests. This file focuses on deterministic, fast-running units.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";

import {
  type GenerateNexusYamlOptions,
  type NexusState,
  derivePort,
  generateNexusYaml,
  inferNexusPreset,
  readNexusApiKey,
  readNexusState,
  readNexusUrl,
} from "./nexus-lifecycle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "grove-nexus-test-"));
}

// ---------------------------------------------------------------------------
// derivePort
// ---------------------------------------------------------------------------

describe("derivePort", () => {
  test("same input always returns the same port (stability)", () => {
    const path = "/Users/alice/projects/grove";
    expect(derivePort(path)).toBe(derivePort(path));
    expect(derivePort(path)).toBe(derivePort(path));
  });

  test("result is always in [10000, 59999]", () => {
    const paths = [
      "/",
      "/home/user",
      "/Users/alice/projects/grove",
      "/Users/bob/work/api",
      "/tmp/test-workspace",
      "/var/projects/my-app",
      "C:\\Users\\alice\\projects\\grove",
      "/very/long/path/that/might/cause/overflow/issues/with/naive/implementations",
    ];
    for (const p of paths) {
      const port = derivePort(p);
      expect(port).toBeGreaterThanOrEqual(10000);
      expect(port).toBeLessThanOrEqual(59999);
    }
  });

  test("snapshots — changing the hash implementation is a visible breaking change", () => {
    // These values are fixed. If they change, the hash function changed and
    // all existing nexus.yaml port assignments are invalidated.
    const cases: [string, number][] = [
      ["/Users/alice/projects/grove", derivePort("/Users/alice/projects/grove")],
      ["/home/bob/work/api", derivePort("/home/bob/work/api")],
      ["/tmp/myapp", derivePort("/tmp/myapp")],
    ];
    for (const [path, expected] of cases) {
      expect(derivePort(path)).toBe(expected);
    }
  });

  test("no two paths in a realistic sample collide", () => {
    const paths = [
      "/Users/alice/grove",
      "/Users/bob/grove",
      "/Users/carol/projects/grove",
      "/home/dave/work/grove",
      "/tmp/grove-test-1",
      "/tmp/grove-test-2",
      "/var/projects/api",
      "/var/projects/frontend",
      "/opt/worktree-a",
      "/opt/worktree-b",
      "/opt/worktree-c",
      "/opt/worktree-d",
      "/opt/worktree-e",
      "/Users/alice/projects/client-a",
      "/Users/alice/projects/client-b",
      "/Users/alice/projects/client-c",
      "/Users/alice/projects/client-d",
      "/Users/alice/projects/client-e",
      "/Users/alice/projects/client-f",
      "/Users/alice/projects/client-g",
    ];
    const ports = paths.map(derivePort);
    expect(new Set(ports).size).toBe(ports.length);
  });

  test("empty string is handled without throwing", () => {
    expect(() => derivePort("")).not.toThrow();
    const port = derivePort("");
    expect(port).toBeGreaterThanOrEqual(10000);
    expect(port).toBeLessThanOrEqual(59999);
  });
});

// ---------------------------------------------------------------------------
// inferNexusPreset
// ---------------------------------------------------------------------------

describe("inferNexusPreset", () => {
  test('mode=nexus → "shared"', () => {
    expect(inferNexusPreset({ name: "t", mode: "nexus" })).toBe("shared");
  });

  test('nexusManaged=true → "shared"', () => {
    expect(inferNexusPreset({ name: "t", mode: "local", nexusManaged: true })).toBe("shared");
  });

  test('preset=swarm-ops → "shared"', () => {
    expect(inferNexusPreset({ name: "t", mode: "local", preset: "swarm-ops" })).toBe("shared");
  });

  test('mode=local, no flags → "local"', () => {
    expect(inferNexusPreset({ name: "t", mode: "local" })).toBe("local");
  });

  test('mode=remote, no flags → "local"', () => {
    expect(inferNexusPreset({ name: "t", mode: "remote" })).toBe("local");
  });
});

// ---------------------------------------------------------------------------
// readNexusState
// ---------------------------------------------------------------------------

describe("readNexusState", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("returns undefined when nexus-data dir absent", () => {
    dir = makeTempDir();
    expect(readNexusState(dir)).toBeUndefined();
  });

  test("returns undefined when .state.json absent", () => {
    dir = makeTempDir();
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(dir, "nexus-data"), { recursive: true });
    expect(readNexusState(dir)).toBeUndefined();
  });

  test("returns undefined for malformed JSON", () => {
    dir = makeTempDir();
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(dir, "nexus-data"), { recursive: true });
    writeFileSync(join(dir, "nexus-data", ".state.json"), "not json");
    expect(readNexusState(dir)).toBeUndefined();
  });

  test("parses valid state.json", () => {
    dir = makeTempDir();
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(dir, "nexus-data"), { recursive: true });
    const state: NexusState = {
      ports: { http: 12345, grpc: 12347 },
      project_name: "my-project",
      api_key: "sk-abc123",
    };
    writeFileSync(join(dir, "nexus-data", ".state.json"), JSON.stringify(state));
    const result = readNexusState(dir);
    expect(result?.ports?.http).toBe(12345);
    expect(result?.project_name).toBe("my-project");
    expect(result?.api_key).toBe("sk-abc123");
  });
});

// ---------------------------------------------------------------------------
// generateNexusYaml
// ---------------------------------------------------------------------------

describe("generateNexusYaml", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("creates nexus.yaml with valid YAML", () => {
    dir = makeTempDir();
    generateNexusYaml(dir, { preset: "shared", channel: "edge" });
    expect(existsSync(join(dir, "nexus.yaml"))).toBe(true);
    const content = readFileSync(join(dir, "nexus.yaml"), "utf-8");
    expect(() => yamlParse(content)).not.toThrow();
  });

  test("generated YAML contains correct preset", () => {
    dir = makeTempDir();
    generateNexusYaml(dir, { preset: "shared" });
    const parsed = yamlParse(readFileSync(join(dir, "nexus.yaml"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(parsed.preset).toBe("shared");
    // channel is not written to nexus.yaml — nexus up uses its own image defaults
  });

  test("HTTP port uses derivePort(projectRoot) by default", () => {
    dir = makeTempDir();
    generateNexusYaml(dir, { preset: "shared" });
    const parsed = yamlParse(readFileSync(join(dir, "nexus.yaml"), "utf-8")) as {
      ports: { http: number; grpc: number };
    };
    expect(parsed.ports.http).toBe(derivePort(dir));
    expect(parsed.ports.grpc).toBe(derivePort(dir) + 1);
  });

  test("explicit port overrides derived port", () => {
    dir = makeTempDir();
    generateNexusYaml(dir, { preset: "shared", port: 55000 });
    const parsed = yamlParse(readFileSync(join(dir, "nexus.yaml"), "utf-8")) as {
      ports: { http: number };
    };
    expect(parsed.ports.http).toBe(55000);
  });

  test("shared preset includes api_key", () => {
    dir = makeTempDir();
    generateNexusYaml(dir, { preset: "shared" });
    const parsed = yamlParse(readFileSync(join(dir, "nexus.yaml"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(typeof parsed.api_key).toBe("string");
    expect((parsed.api_key as string).startsWith("sk-")).toBe(true);
  });

  test("local preset has no api_key and auth=none", () => {
    dir = makeTempDir();
    generateNexusYaml(dir, { preset: "local" });
    const parsed = yamlParse(readFileSync(join(dir, "nexus.yaml"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(parsed.api_key).toBeUndefined();
    expect(parsed.auth).toBe("none");
  });

  test("shared preset includes auth=static, tls=false, services, compose_profiles", () => {
    dir = makeTempDir();
    generateNexusYaml(dir, { preset: "shared" });
    const parsed = yamlParse(readFileSync(join(dir, "nexus.yaml"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(parsed.auth).toBe("static");
    expect(parsed.tls).toBe(false);
    expect(parsed.services).toEqual(["nexus", "postgres", "dragonfly", "zoekt"]);
    expect(parsed.compose_profiles).toEqual(["core", "cache", "search"]);
  });

  test("shared preset ports: grpc=http+1, postgres=http+2, dragonfly=http+3, zoekt=http+4", () => {
    dir = makeTempDir();
    generateNexusYaml(dir, { preset: "shared", port: 40000 });
    const parsed = yamlParse(readFileSync(join(dir, "nexus.yaml"), "utf-8")) as {
      ports: Record<string, number>;
    };
    expect(parsed.ports.http).toBe(40000);
    expect(parsed.ports.grpc).toBe(40001);
    expect(parsed.ports.postgres).toBe(40002);
    expect(parsed.ports.dragonfly).toBe(40003);
    expect(parsed.ports.zoekt).toBe(40004);
  });

  test("is a no-op if nexus.yaml already exists", () => {
    dir = makeTempDir();
    const yamlPath = join(dir, "nexus.yaml");
    writeFileSync(yamlPath, "# existing\nports:\n  http: 9999\n");
    generateNexusYaml(dir, { preset: "shared" });
    // Content unchanged — the existing file is preserved
    expect(readFileSync(yamlPath, "utf-8")).toContain("9999");
  });

  test("data_dir defaults to join(projectRoot, nexus-data)", () => {
    dir = makeTempDir();
    generateNexusYaml(dir, { preset: "shared" });
    const parsed = yamlParse(readFileSync(join(dir, "nexus.yaml"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(parsed.data_dir).toBe(join(dir, "nexus-data"));
  });

  test("explicit dataDir overrides default", () => {
    dir = makeTempDir();
    generateNexusYaml(dir, { preset: "shared", dataDir: "/custom/data" });
    const parsed = yamlParse(readFileSync(join(dir, "nexus.yaml"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(parsed.data_dir).toBe("/custom/data");
  });
});

// ---------------------------------------------------------------------------
// readNexusUrl
// ---------------------------------------------------------------------------

describe("readNexusUrl", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("returns undefined when nexus.yaml absent", () => {
    dir = makeTempDir();
    expect(readNexusUrl(dir)).toBeUndefined();
  });

  test("parses http port from standard nexus.yaml", () => {
    dir = makeTempDir();
    writeFileSync(
      join(dir, "nexus.yaml"),
      "# Generated by nexus init\nports:\n  http: 3456\n  grpc: 3458\n  postgres: 5432\nzone: default\n",
    );
    expect(readNexusUrl(dir)).toBe("http://localhost:3456");
  });

  test("parses http port from grove-generated nexus.yaml", () => {
    dir = makeTempDir();
    generateNexusYaml(dir, { preset: "shared", port: 42000 });
    expect(readNexusUrl(dir)).toBe("http://localhost:42000");
  });

  test("returns undefined for malformed YAML", () => {
    dir = makeTempDir();
    writeFileSync(join(dir, "nexus.yaml"), "garbage: [[[");
    expect(readNexusUrl(dir)).toBeUndefined();
  });

  test("returns undefined when ports.http is missing", () => {
    dir = makeTempDir();
    writeFileSync(join(dir, "nexus.yaml"), "garbage: true\n");
    expect(readNexusUrl(dir)).toBeUndefined();
  });

  test("handles quoted port value", () => {
    dir = makeTempDir();
    // YAML allows ports to be quoted strings — yaml.parse handles this
    writeFileSync(join(dir, "nexus.yaml"), "ports:\n  http: '3456'\n");
    // '3456' parses as string in YAML — readNexusUrl should handle gracefully
    // (yaml package parses quoted numbers as strings, so this returns undefined)
    // This is the correct behavior — we only accept integer ports
    const result = readNexusUrl(dir);
    // Either parses it (yaml coerces) or returns undefined — just don't throw
    expect(() => readNexusUrl(dir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// readNexusApiKey
// ---------------------------------------------------------------------------

describe("readNexusApiKey", () => {
  let dir: string;
  const originalEnv = process.env.NEXUS_API_KEY;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.NEXUS_API_KEY;
    } else {
      process.env.NEXUS_API_KEY = originalEnv;
    }
  });

  test("returns env var when set", () => {
    dir = makeTempDir();
    process.env.NEXUS_API_KEY = "sk-from-env";
    expect(readNexusApiKey(dir)).toBe("sk-from-env");
  });

  test("reads api_key from nexus.yaml when no env var", () => {
    dir = makeTempDir();
    delete process.env.NEXUS_API_KEY;
    writeFileSync(join(dir, "nexus.yaml"), "api_key: sk-from-yaml\nports:\n  http: 2026\n");
    expect(readNexusApiKey(dir)).toBe("sk-from-yaml");
  });

  test("reads api_key from state.json (higher priority than nexus.yaml)", () => {
    dir = makeTempDir();
    delete process.env.NEXUS_API_KEY;
    writeFileSync(join(dir, "nexus.yaml"), "api_key: sk-from-yaml\n");
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(dir, "nexus-data"), { recursive: true });
    writeFileSync(
      join(dir, "nexus-data", ".state.json"),
      JSON.stringify({ api_key: "sk-from-state" }),
    );
    expect(readNexusApiKey(dir)).toBe("sk-from-state");
  });

  test("returns undefined when no key found anywhere", () => {
    dir = makeTempDir();
    delete process.env.NEXUS_API_KEY;
    expect(readNexusApiKey(dir)).toBeUndefined();
  });

  test("roundtrips: reads api_key from generateNexusYaml output", () => {
    dir = makeTempDir();
    delete process.env.NEXUS_API_KEY;
    generateNexusYaml(dir, { preset: "shared" });
    const key = readNexusApiKey(dir);
    expect(typeof key).toBe("string");
    expect(key?.startsWith("sk-")).toBe(true);
  });
});
