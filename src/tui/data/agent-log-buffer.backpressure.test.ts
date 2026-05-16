/**
 * Acceptance test for issue #310: 1k lines/sec, no drops, coalesced notifies.
 *
 * Pushes 1000 lines synchronously into an AgentLogBuffer constructed with
 * flushMs=50. Asserts:
 *   - every write reaches the buffer (lossless ingest)
 *   - subscriber is notified at most ceil(elapsed / 50) + 1 times (coalesced)
 */

import { describe, expect, test } from "bun:test";
import { AgentLogBuffer } from "./agent-log-buffer.js";

describe("AgentLogBuffer backpressure (#310)", () => {
  test("1000 sync pushes: lossless and coalesced at 50ms", async () => {
    const buf = new AgentLogBuffer("coder", "sess-bp", 10_000, 50);
    let notifies = 0;
    buf.subscribe(() => {
      notifies += 1;
    });

    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      buf.push({ ts: start + i, line: `line-${i}`, type: "output" });
    }

    await new Promise((r) => setTimeout(r, 120));

    const elapsedMs = Date.now() - start;
    const maxNotifies = Math.ceil(elapsedMs / 50) + 1;

    expect(buf.size).toBe(1000);
    expect(notifies).toBeGreaterThan(0);
    expect(notifies).toBeLessThanOrEqual(maxNotifies);

    buf.dispose();
  });

  test("staggered pushes across 200ms: still lossless", async () => {
    const buf = new AgentLogBuffer("coder", "sess-bp2", 10_000, 50);

    for (let batch = 0; batch < 5; batch++) {
      for (let i = 0; i < 200; i++) {
        buf.push({ ts: Date.now(), line: `b${batch}-${i}`, type: "output" });
      }
      await new Promise((r) => setTimeout(r, 40));
    }

    await new Promise((r) => setTimeout(r, 120));
    expect(buf.size).toBe(1000);

    buf.dispose();
  });
});
