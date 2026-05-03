/**
 * Smoke tests for `startAgentOutputPublisher` (#390 / A8.4).
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { GroveEvent } from "../core/event-bus.js";
import { TUI_REFRESH_ROLE } from "../core/event-bus.js";
import { LocalEventBus } from "../core/local-event-bus.js";
import { startAgentOutputPublisher, type TmuxOutputSource } from "./agent-output-publisher.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeTmux implements TmuxOutputSource {
  available = true;
  sessions: string[] = [];
  output = new Map<string, string>();
  captures = 0;

  async isAvailable(): Promise<boolean> {
    return this.available;
  }
  async listSessions(): Promise<readonly string[]> {
    return this.sessions;
  }
  async capturePanes(name: string): Promise<string> {
    this.captures++;
    return this.output.get(name) ?? "";
  }
}

describe("startAgentOutputPublisher", () => {
  let stopFn: (() => void) | undefined;
  afterEach(() => {
    stopFn?.();
    stopFn = undefined;
  });

  test("emits agent.output when a session's pane content changes", async () => {
    const bus = new LocalEventBus();
    const events: GroveEvent[] = [];
    bus.subscribe(TUI_REFRESH_ROLE, (e) => events.push(e));

    const tmux = new FakeTmux();
    tmux.sessions = ["grove-a"];
    tmux.output.set("grove-a", "first");

    const handle = startAgentOutputPublisher({ eventBus: bus, tmux, pollMs: 30 });
    stopFn = handle.stop;

    await sleep(80);
    const before = events.length;
    expect(before).toBeGreaterThanOrEqual(1);

    tmux.output.set("grove-a", "second");
    await sleep(80);
    expect(events.length).toBeGreaterThan(before);

    bus.close();
  });

  test("does not emit when no session content changes", async () => {
    const bus = new LocalEventBus();
    const events: GroveEvent[] = [];
    bus.subscribe(TUI_REFRESH_ROLE, (e) => events.push(e));

    const tmux = new FakeTmux();
    tmux.sessions = ["grove-a"];
    tmux.output.set("grove-a", "stable");

    const handle = startAgentOutputPublisher({ eventBus: bus, tmux, pollMs: 30 });
    stopFn = handle.stop;

    await sleep(50); // initial emit
    const initial = events.length;
    await sleep(120); // no further change
    expect(events.length).toBe(initial);

    bus.close();
  });

  test("publishes targetRole=TUI_REFRESH_ROLE", async () => {
    const bus = new LocalEventBus();
    const events: GroveEvent[] = [];
    bus.subscribe(TUI_REFRESH_ROLE, (e) => events.push(e));

    const tmux = new FakeTmux();
    tmux.sessions = ["grove-a"];
    tmux.output.set("grove-a", "x");

    const handle = startAgentOutputPublisher({ eventBus: bus, tmux, pollMs: 30 });
    stopFn = handle.stop;

    await sleep(80);
    expect(events[0]?.type).toBe("agent.output");
    expect(events[0]?.targetRole).toBe(TUI_REFRESH_ROLE);

    bus.close();
  });

  test("stop() halts polling", async () => {
    const bus = new LocalEventBus();
    const events: GroveEvent[] = [];
    bus.subscribe(TUI_REFRESH_ROLE, (e) => events.push(e));

    const tmux = new FakeTmux();
    tmux.sessions = ["grove-a"];
    tmux.output.set("grove-a", "x");

    const handle = startAgentOutputPublisher({ eventBus: bus, tmux, pollMs: 30 });
    stopFn = undefined;
    await sleep(50);
    handle.stop();
    const at_stop = tmux.captures;
    await sleep(120);
    expect(tmux.captures).toBe(at_stop);

    bus.close();
  });
});
