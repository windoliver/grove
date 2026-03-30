/**
 * Tests for ScreenManager — verifies structural correctness after the
 * SpawnManager lift to tui-app.tsx (issue #174).
 *
 * Full rendering tests require OpenTUI test harness; these structural
 * tests verify the singleton guarantee and correct context consumption.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const SRC = readFileSync(resolve(import.meta.dir, "screen-manager.tsx"), "utf-8");

describe("ScreenManager SpawnManager consumption", () => {
  test("consumes SpawnManager via useSpawnManager() hook", () => {
    expect(SRC).toContain("useSpawnManager()");
  });

  test("does not create its own SpawnManager instance", () => {
    expect(SRC).not.toContain("new SpawnManager(");
  });

  test("does not create its own FileSessionStore", () => {
    expect(SRC).not.toContain("new FileSessionStore(");
    expect(SRC).not.toContain("FileSessionStore");
  });

  test("does not wire NexusWsBridge (owned by tui-app.tsx)", () => {
    expect(SRC).not.toContain("NexusWsBridge");
    expect(SRC).not.toContain("nexus-ws-bridge");
  });

  test("does not call spawnManager.destroy() (owned by tui-app.tsx)", () => {
    // destroy() cleanup is now in tui-app.tsx's useEffect, not ScreenManager
    expect(SRC).not.toContain("spawnManager.destroy()");
    expect(SRC).not.toContain("spawnManager?.destroy()");
  });
});
