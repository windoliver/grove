/**
 * Smoke tests for `startVfsEventPublisher` (#390 / A8.4).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GroveEvent } from "../core/event-bus.js";
import { TUI_REFRESH_ROLE } from "../core/event-bus.js";
import { LocalEventBus } from "../core/local-event-bus.js";
import { startVfsEventPublisher } from "./vfs-event-publisher.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("startVfsEventPublisher", () => {
  let tmpRoot: string;
  let groveDir: string;
  let workspacesDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "vfs-event-pub-"));
    groveDir = join(tmpRoot, ".grove");
    workspacesDir = join(groveDir, "workspaces");
    mkdirSync(workspacesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Wait up to `timeoutMs` for `pred` to become true; checked every `stepMs`.
  const waitFor = async (pred: () => boolean, timeoutMs = 2000, stepMs = 30) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (pred()) return;
      await sleep(stepMs);
    }
  };

  test("publishes vfs.changed when a file is added to workspaces", async () => {
    const bus = new LocalEventBus();
    const events: GroveEvent[] = [];
    bus.subscribe(TUI_REFRESH_ROLE, (e) => events.push(e));

    const handle = startVfsEventPublisher({ eventBus: bus, groveDir, coalesceMs: 50 });

    // Settle the watcher attach before triggering — fs.watch needs a beat
    // before it begins delivering events on some platforms.
    await sleep(50);
    writeFileSync(join(workspacesDir, "a.txt"), "hello");

    await waitFor(() => events.length > 0);

    expect(events.length).toBeGreaterThan(0);
    const evt = events[0];
    expect(evt?.type).toBe("vfs.changed");
    expect(evt?.targetRole).toBe(TUI_REFRESH_ROLE);

    handle.stop();
    bus.close();
  });

  test("coalesces bursts into a single emission", async () => {
    const bus = new LocalEventBus();
    const events: GroveEvent[] = [];
    bus.subscribe(TUI_REFRESH_ROLE, (e) => events.push(e));

    const handle = startVfsEventPublisher({ eventBus: bus, groveDir, coalesceMs: 200 });
    await sleep(50);

    for (let i = 0; i < 10; i++) writeFileSync(join(workspacesDir, `f${i}.txt`), String(i));
    await waitFor(() => events.length > 0);
    // Allow coalesce window to flush
    await sleep(250);

    expect(events.length).toBeLessThanOrEqual(2);

    handle.stop();
    bus.close();
  });

  test("stop() detaches the watcher", async () => {
    const bus = new LocalEventBus();
    const events: GroveEvent[] = [];
    bus.subscribe(TUI_REFRESH_ROLE, (e) => events.push(e));

    const handle = startVfsEventPublisher({ eventBus: bus, groveDir, coalesceMs: 50 });
    await sleep(50);
    handle.stop();

    writeFileSync(join(workspacesDir, "after-stop.txt"), "x");
    await sleep(200);

    expect(events.length).toBe(0);
    bus.close();
  });

  test("missing workspaces dir is non-fatal", () => {
    rmSync(workspacesDir, { recursive: true, force: true });
    const bus = new LocalEventBus();

    const handle = startVfsEventPublisher({ eventBus: bus, groveDir });
    expect(() => handle.stop()).not.toThrow();
    bus.close();
  });
});
