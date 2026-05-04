/**
 * Smoke tests for `startGitHubPrPublisher` (#390 / A8.4).
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { GroveEvent } from "../core/event-bus.js";
import { TUI_REFRESH_ROLE } from "../core/event-bus.js";
import { LocalEventBus } from "../core/local-event-bus.js";
import { type PrSnapshot, startGitHubPrPublisher } from "./github-pr-publisher.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("startGitHubPrPublisher", () => {
  let stopFn: (() => void) | undefined;
  afterEach(() => {
    stopFn?.();
    stopFn = undefined;
  });

  test("emits github.pr.changed on first successful tick", async () => {
    const bus = new LocalEventBus();
    const events: GroveEvent[] = [];
    bus.subscribe(TUI_REFRESH_ROLE, (e) => events.push(e));

    const snap: PrSnapshot = { number: 42, state: "open", headSha: "abc" };
    const handle = startGitHubPrPublisher({
      eventBus: bus,
      getActivePR: async () => snap,
      pollMs: 30,
    });
    stopFn = handle.stop;

    await sleep(60);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.type).toBe("github.pr.changed");
    expect(events[0]?.targetRole).toBe(TUI_REFRESH_ROLE);

    bus.close();
  });

  test("does not re-emit when snapshot is unchanged", async () => {
    const bus = new LocalEventBus();
    const events: GroveEvent[] = [];
    bus.subscribe(TUI_REFRESH_ROLE, (e) => events.push(e));

    let snap: PrSnapshot = { number: 1, state: "open" };
    const handle = startGitHubPrPublisher({
      eventBus: bus,
      getActivePR: async () => snap,
      pollMs: 30,
    });
    stopFn = handle.stop;

    await sleep(50);
    const initial = events.length;
    await sleep(120);
    expect(events.length).toBe(initial);

    snap = { number: 1, state: "merged" };
    await sleep(60);
    expect(events.length).toBeGreaterThan(initial);

    bus.close();
  });

  test("stop() halts polling", async () => {
    const bus = new LocalEventBus();
    let calls = 0;
    const handle = startGitHubPrPublisher({
      eventBus: bus,
      getActivePR: async () => {
        calls++;
        return { number: 1, state: "open" };
      },
      pollMs: 30,
    });
    stopFn = undefined;
    await sleep(40);
    handle.stop();
    const atStop = calls;
    await sleep(120);
    expect(calls).toBe(atStop);

    bus.close();
  });

  test("transient fetch errors are non-fatal", async () => {
    const bus = new LocalEventBus();
    let mode: "throw" | "ok" = "throw";
    const handle = startGitHubPrPublisher({
      eventBus: bus,
      getActivePR: async () => {
        if (mode === "throw") throw new Error("network");
        return { number: 7, state: "open" };
      },
      pollMs: 30,
    });
    stopFn = handle.stop;

    await sleep(80);
    mode = "ok";
    const events: GroveEvent[] = [];
    bus.subscribe(TUI_REFRESH_ROLE, (e) => events.push(e));
    await sleep(80);
    expect(events.length).toBeGreaterThanOrEqual(1);

    bus.close();
  });
});
