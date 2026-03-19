/**
 * Tests for ~/.grove/connection.json persistence.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearPersistedConnection,
  loadPersistedConnection,
  savePersistedConnection,
} from "./connection-store.js";

describe("connection-store", () => {
  let originalHome: string | undefined;
  let tempHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), "grove-conn-test-"));
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // save + load round-trip
  // ---------------------------------------------------------------------------

  test("save and load round-trip", () => {
    const conn = {
      nexusUrl: "http://localhost:2026",
      lastConnectedAt: "2026-03-19T00:00:00.000Z",
    };
    savePersistedConnection(conn);
    const loaded = loadPersistedConnection();
    expect(loaded).toEqual(conn);
  });

  test("save with apiKey", () => {
    const conn = {
      nexusUrl: "http://nexus:8080",
      apiKey: "secret-key",
      lastConnectedAt: "2026-03-19T12:00:00.000Z",
    };
    savePersistedConnection(conn);
    const loaded = loadPersistedConnection();
    expect(loaded).toEqual(conn);
  });

  test("save overwrites previous value", () => {
    savePersistedConnection({
      nexusUrl: "http://old:1111",
      lastConnectedAt: "2026-01-01T00:00:00.000Z",
    });
    savePersistedConnection({
      nexusUrl: "http://new:2222",
      lastConnectedAt: "2026-03-19T00:00:00.000Z",
    });
    const loaded = loadPersistedConnection();
    expect(loaded?.nexusUrl).toBe("http://new:2222");
  });

  // ---------------------------------------------------------------------------
  // load edge cases
  // ---------------------------------------------------------------------------

  test("load returns undefined when file missing", () => {
    expect(loadPersistedConnection()).toBeUndefined();
  });

  test("load returns undefined when ~/.grove dir missing", () => {
    // HOME points to tempHome which has no .grove/ dir
    expect(loadPersistedConnection()).toBeUndefined();
  });

  test("load returns undefined for corrupt JSON", () => {
    const groveDir = join(tempHome, ".grove");
    mkdirSync(groveDir, { recursive: true });
    writeFileSync(join(groveDir, "connection.json"), "not json{{{", "utf-8");
    expect(loadPersistedConnection()).toBeUndefined();
  });

  test("load returns undefined when nexusUrl is missing", () => {
    const groveDir = join(tempHome, ".grove");
    mkdirSync(groveDir, { recursive: true });
    writeFileSync(
      join(groveDir, "connection.json"),
      JSON.stringify({ lastConnectedAt: "2026-01-01T00:00:00.000Z" }),
      "utf-8",
    );
    expect(loadPersistedConnection()).toBeUndefined();
  });

  test("load returns undefined when nexusUrl is empty string", () => {
    const groveDir = join(tempHome, ".grove");
    mkdirSync(groveDir, { recursive: true });
    writeFileSync(
      join(groveDir, "connection.json"),
      JSON.stringify({ nexusUrl: "", lastConnectedAt: "2026-01-01T00:00:00.000Z" }),
      "utf-8",
    );
    expect(loadPersistedConnection()).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // save creates ~/.grove if missing
  // ---------------------------------------------------------------------------

  test("save creates ~/.grove directory if missing", () => {
    expect(existsSync(join(tempHome, ".grove"))).toBe(false);
    savePersistedConnection({
      nexusUrl: "http://localhost:2026",
      lastConnectedAt: "2026-03-19T00:00:00.000Z",
    });
    expect(existsSync(join(tempHome, ".grove", "connection.json"))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // clear
  // ---------------------------------------------------------------------------

  test("clear removes the file", () => {
    savePersistedConnection({
      nexusUrl: "http://localhost:2026",
      lastConnectedAt: "2026-03-19T00:00:00.000Z",
    });
    expect(loadPersistedConnection()).toBeDefined();
    clearPersistedConnection();
    expect(loadPersistedConnection()).toBeUndefined();
  });

  test("clear is safe when file does not exist", () => {
    // Should not throw
    clearPersistedConnection();
  });

  // ---------------------------------------------------------------------------
  // Atomic write — file is valid JSON after save
  // ---------------------------------------------------------------------------

  test("saved file is valid JSON", () => {
    savePersistedConnection({
      nexusUrl: "http://localhost:2026",
      lastConnectedAt: "2026-03-19T00:00:00.000Z",
    });
    const raw = readFileSync(join(tempHome, ".grove", "connection.json"), "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
