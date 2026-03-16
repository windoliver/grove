/**
 * Tests for init progress callback (12A).
 *
 * Verifies that executeInit fires progress events in order
 * as each initialization step completes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeInit, type InitOptions } from "./init.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "grove-init-progress-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeOptions(overrides?: Partial<InitOptions>): InitOptions {
  return {
    name: "test-grove",
    mode: "evaluation",
    seed: [],
    metric: [],
    force: false,
    agentOverrides: {},
    cwd: tmpDir,
    ...overrides,
  };
}

describe("executeInit progress callback", () => {
  test("fires progress events in order", async () => {
    const steps: { step: number; label: string }[] = [];

    await executeInit(makeOptions(), (step, label) => {
      steps.push({ step, label });
    });

    // Verify at least 5 steps were reported
    expect(steps.length).toBeGreaterThanOrEqual(5);

    // Verify steps are in ascending order
    for (let i = 1; i < steps.length; i++) {
      const prev = steps[i - 1];
      const curr = steps[i];
      if (prev && curr) {
        expect(curr.step).toBeGreaterThanOrEqual(prev.step);
      }
    }

    // Verify specific step labels exist
    const labels = steps.map((s) => s.label);
    expect(labels.some((l) => l.includes("Validating"))).toBe(true);
    expect(labels.some((l) => l.includes("directory"))).toBe(true);
    expect(labels.some((l) => l.includes("database"))).toBe(true);
    expect(labels.some((l) => l.includes("GROVE.md"))).toBe(true);
    expect(labels.some((l) => l.includes("configuration"))).toBe(true);
  });

  test("fires step 0 (validation) first", async () => {
    const steps: number[] = [];

    await executeInit(makeOptions(), (step) => {
      steps.push(step);
    });

    expect(steps[0]).toBe(0);
  });

  test("grove is fully initialized after all steps", async () => {
    await executeInit(makeOptions());

    expect(existsSync(join(tmpDir, ".grove"))).toBe(true);
    expect(existsSync(join(tmpDir, ".grove", "grove.db"))).toBe(true);
    expect(existsSync(join(tmpDir, ".grove", "cas"))).toBe(true);
    expect(existsSync(join(tmpDir, "GROVE.md"))).toBe(true);
  });

  test("works without progress callback (backward compatible)", async () => {
    // Should not throw when no callback is provided
    await executeInit(makeOptions());
    expect(existsSync(join(tmpDir, ".grove"))).toBe(true);
  });
});

describe("executeInit progress step count", () => {
  test("fires all 6 defined progress steps", async () => {
    const steps: number[] = [];

    await executeInit(makeOptions(), (step) => {
      steps.push(step);
    });

    // Steps 0-5 should all fire (validation, dirs, DB, GROVE.md, config, seed)
    expect(steps).toContain(0);
    expect(steps).toContain(1);
    expect(steps).toContain(2);
    expect(steps).toContain(3);
    expect(steps).toContain(4);
    expect(steps).toContain(5);
  });
});
