import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  defaultRegistryPath,
  loadRegistry,
  lookupByOrigin,
  saveRegistry,
  upsertEntry,
  type Registry,
  type RegistryEntry,
} from "./project-registry.js";

function makeTmpFile(basename: string): string {
  const dir = join(
    tmpdir(),
    `grove-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return join(dir, basename);
}

describe("Registry types", () => {
  test("RegistryEntry requires id, name, createdAt", () => {
    const e: RegistryEntry = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "foo/bar",
      createdAt: "2026-04-24T00:00:00.000Z",
    };
    expect(e.id).toBeDefined();
  });

  test("Registry has version: 1 and projects map", () => {
    const r: Registry = { version: 1, projects: {} };
    expect(r.version).toBe(1);
    expect(r.projects).toEqual({});
  });
});

describe("defaultRegistryPath", () => {
  test("returns $HOME/.grove/projects.yaml", () => {
    expect(defaultRegistryPath()).toBe(join(homedir(), ".grove", "projects.yaml"));
  });
});

describe("loadRegistry", () => {
  test("returns empty registry when file is missing", () => {
    const path = makeTmpFile("projects.yaml");
    const r = loadRegistry(path);
    expect(r).toEqual({ version: 1, projects: {} });
  });

  test("loads a well-formed registry", () => {
    const path = makeTmpFile("projects.yaml");
    writeFileSync(
      path,
      [
        "version: 1",
        "projects:",
        "  github.com/foo/bar:",
        "    id: 550e8400-e29b-41d4-a716-446655440000",
        "    name: foo/bar",
        "    createdAt: 2026-04-24T00:00:00.000Z",
        "",
      ].join("\n"),
    );
    const r = loadRegistry(path);
    expect(r.version).toBe(1);
    expect(r.projects["github.com/foo/bar"]?.id).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(r.projects["github.com/foo/bar"]?.name).toBe("foo/bar");
  });

  test("throws on malformed YAML", () => {
    const path = makeTmpFile("projects.yaml");
    writeFileSync(path, ":: this is not valid yaml ::\n  - [\n");
    expect(() => loadRegistry(path)).toThrow();
  });

  test("throws on unknown version", () => {
    const path = makeTmpFile("projects.yaml");
    writeFileSync(path, "version: 2\nprojects: {}\n");
    expect(() => loadRegistry(path)).toThrow(/version/i);
  });

  test("throws when an entry has a non-UUIDv4 id", () => {
    const path = makeTmpFile("projects.yaml");
    writeFileSync(
      path,
      [
        "version: 1",
        "projects:",
        "  github.com/foo/bar:",
        "    id: not-a-uuid",
        "    name: foo/bar",
        "    createdAt: 2026-04-24T00:00:00.000Z",
        "",
      ].join("\n"),
    );
    expect(() => loadRegistry(path)).toThrow(/invalid/i);
  });
});

describe("saveRegistry", () => {
  test("creates parent directory if missing", () => {
    const path = join(makeTmpFile("unused").replace(/\/[^/]+$/, ""), "nested", "projects.yaml");
    const reg: Registry = {
      version: 1,
      projects: {
        "github.com/foo/bar": {
          id: "550e8400-e29b-41d4-a716-446655440000",
          name: "foo/bar",
          createdAt: "2026-04-24T00:00:00.000Z",
        },
      },
    };
    saveRegistry(path, reg);
    expect(existsSync(dirname(path))).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  test("round-trips through loadRegistry", () => {
    const path = makeTmpFile("projects.yaml");
    const reg: Registry = {
      version: 1,
      projects: {
        "github.com/foo/bar": {
          id: "550e8400-e29b-41d4-a716-446655440000",
          name: "foo/bar",
          createdAt: "2026-04-24T00:00:00.000Z",
        },
      },
    };
    saveRegistry(path, reg);
    expect(loadRegistry(path)).toEqual(reg);
  });

  test("writes with version: 1 field visible at top of file", () => {
    const path = makeTmpFile("projects.yaml");
    saveRegistry(path, { version: 1, projects: {} });
    const raw = readFileSync(path, "utf8");
    expect(raw.startsWith("version: 1")).toBe(true);
  });
});

describe("lookupByOrigin", () => {
  const reg: Registry = {
    version: 1,
    projects: {
      "github.com/foo/bar": {
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "foo/bar",
        createdAt: "2026-04-24T00:00:00.000Z",
      },
    },
  };

  test("returns entry on hit", () => {
    expect(lookupByOrigin(reg, "github.com/foo/bar")?.id).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  test("returns null on miss", () => {
    expect(lookupByOrigin(reg, "gitlab.com/acme/service")).toBeNull();
  });
});

describe("upsertEntry", () => {
  const base: Registry = { version: 1, projects: {} };

  test("adds a new entry without mutating input", () => {
    const next = upsertEntry(base, "github.com/foo/bar", {
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "foo/bar",
      createdAt: "2026-04-24T00:00:00.000Z",
    });
    expect(next.projects["github.com/foo/bar"]?.id).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(base.projects["github.com/foo/bar"]).toBeUndefined();
  });

  test("overwrites an existing entry", () => {
    const seeded: Registry = {
      version: 1,
      projects: {
        "github.com/foo/bar": {
          id: "550e8400-e29b-41d4-a716-446655440000",
          name: "foo/bar",
          createdAt: "2026-04-24T00:00:00.000Z",
        },
      },
    };
    const next = upsertEntry(seeded, "github.com/foo/bar", {
      id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      name: "foo/bar",
      createdAt: "2026-04-25T00:00:00.000Z",
    });
    expect(next.projects["github.com/foo/bar"]?.id).toBe(
      "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    );
  });
});
