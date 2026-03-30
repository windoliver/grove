/**
 * Tests for SpawnManagerContext — verifies:
 * 1. Context default value is undefined (triggers the throw guard in useSpawnManager).
 * 2. useSpawnManager is exported and callable.
 * 3. SpawnManagerContext has the correct displayName for debugging.
 * 4. Structural singleton guarantee: only tui-app.tsx creates SpawnManager;
 *    screen-manager.tsx and app.tsx consume via useSpawnManager() (no local creation).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { SpawnManagerContext, useSpawnManager } from "./spawn-manager-context.js";

// ---------------------------------------------------------------------------
// Unit tests — context module exports
// ---------------------------------------------------------------------------

describe("SpawnManagerContext module", () => {
  test("context default value is undefined (null-guard sentinel)", () => {
    // React's createContext stores the default as _currentValue.
    // When useContext reads this without a provider, it gets undefined,
    // which triggers useSpawnManager's throw guard.
    const ctx = SpawnManagerContext as unknown as { _currentValue: unknown };
    expect(ctx._currentValue).toBeUndefined();
  });

  test("displayName is set for React DevTools debugging", () => {
    expect(SpawnManagerContext.displayName).toBe("SpawnManagerContext");
  });

  test("useSpawnManager is exported as a function", () => {
    expect(typeof useSpawnManager).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Structural singleton guarantee — verifies that SpawnManager is NOT
// instantiated in screen-manager.tsx or app.tsx (only consumed via context).
// This prevents regression to the dual-instance bug (issue #174).
// ---------------------------------------------------------------------------

describe("SpawnManager singleton guarantee (structural)", () => {
  const tuiDir = resolve(import.meta.dir);

  test("screen-manager.tsx does not import SpawnManager class", () => {
    const src = readFileSync(resolve(tuiDir, "screens/screen-manager.tsx"), "utf-8");
    // Should NOT import the SpawnManager class (only useSpawnManager hook)
    expect(src).not.toContain('from "../spawn-manager.js"');
    expect(src).not.toContain("new SpawnManager(");
  });

  test("screen-manager.tsx imports useSpawnManager from context", () => {
    const src = readFileSync(resolve(tuiDir, "screens/screen-manager.tsx"), "utf-8");
    expect(src).toContain('from "../spawn-manager-context.js"');
    expect(src).toContain("useSpawnManager");
  });

  test("app.tsx does not import SpawnManager class", () => {
    const src = readFileSync(resolve(tuiDir, "app.tsx"), "utf-8");
    // Should NOT import the SpawnManager class (only useSpawnManager hook)
    expect(src).not.toContain('from "./spawn-manager.js"');
    expect(src).not.toContain("new SpawnManager(");
  });

  test("app.tsx imports useSpawnManager from context", () => {
    const src = readFileSync(resolve(tuiDir, "app.tsx"), "utf-8");
    expect(src).toContain('from "./spawn-manager-context.js"');
    expect(src).toContain("useSpawnManager");
  });

  test("tui-app.tsx creates SpawnManager and provides via context", () => {
    const src = readFileSync(resolve(tuiDir, "tui-app.tsx"), "utf-8");
    expect(src).toContain("new SpawnManager(");
    expect(src).toContain("SpawnManagerContext");
    expect(src).toContain('from "./spawn-manager.js"');
    expect(src).toContain('from "./spawn-manager-context.js"');
  });

  test("NexusWsBridge wiring exists only in tui-app.tsx", () => {
    const tuiApp = readFileSync(resolve(tuiDir, "tui-app.tsx"), "utf-8");
    const screenMgr = readFileSync(resolve(tuiDir, "screens/screen-manager.tsx"), "utf-8");
    const app = readFileSync(resolve(tuiDir, "app.tsx"), "utf-8");

    // Only tui-app.tsx should wire the bridge
    expect(tuiApp).toContain("NexusWsBridge");
    expect(screenMgr).not.toContain("NexusWsBridge");
    expect(app).not.toContain("NexusWsBridge");
  });
});
