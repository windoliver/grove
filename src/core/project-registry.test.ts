import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  defaultRegistryPath,
  type Registry,
  type RegistryEntry,
} from "./project-registry.js";

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
