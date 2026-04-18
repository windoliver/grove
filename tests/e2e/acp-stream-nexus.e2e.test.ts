/**
 * E2E: spawn a real acpx agent, publish its typed turn stream through a
 * real Nexus instance, and verify delivery via Nexus HTTP.
 *
 * Skipped unless both NEXUS_URL and NEXUS_API_KEY are set so `bun test`
 * stays green on machines without a running Nexus stack. Also gated on
 * AcpxRuntime.isAvailable() (no mock fallback — acpx absence is a skip).
 *
 * Requires a Nexus agent whose inbox already exists. Configure via
 * NEXUS_TEST_AGENT_ID; the test uses that agent as both sender and
 * recipient so the single API-key auth context matches on both
 * `_check_agent_access` boundaries.
 *
 * Run with the `nexus-stack` skill:
 *   1. Start stack, export NEXUS_URL + NEXUS_API_KEY + NEXUS_TEST_AGENT_ID.
 *   2. bun test tests/e2e/acp-stream-nexus.e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import { AcpxRuntime } from "../../src/core/acpx-runtime.js";
import { publishTurnToNexus } from "../../src/nexus/nexus-agent-publisher.js";
import { NexusEventBus } from "../../src/nexus/nexus-event-bus.js";
import { NexusIpcClient } from "../../src/nexus/nexus-ipc-client.js";

const NEXUS_URL = process.env.NEXUS_URL;
const NEXUS_API_KEY = process.env.NEXUS_API_KEY;
const NEXUS_TEST_AGENT_ID = process.env.NEXUS_TEST_AGENT_ID ?? "grove-e2e";

const gated = Boolean(NEXUS_URL && NEXUS_API_KEY);

async function inboxCount(agentId: string): Promise<number> {
  const resp = await fetch(`${NEXUS_URL}/api/v2/ipc/inbox/${encodeURIComponent(agentId)}/count`, {
    headers: { Authorization: `Bearer ${NEXUS_API_KEY}` },
  });
  if (!resp.ok) throw new Error(`inbox count failed: HTTP ${resp.status}`);
  const body = (await resp.json()) as { count: number };
  return body.count;
}

describe.skipIf(!gated)("acp stream → Nexus E2E", () => {
  test("published turn events land in the recipient's Nexus inbox", async () => {
    const rt = new AcpxRuntime();
    if (!(await rt.isAvailable())) {
      console.warn("[skip] acpx not installed");
      return;
    }

    const ipc = new NexusIpcClient({
      nexusUrl: NEXUS_URL as string,
      apiKey: NEXUS_API_KEY as string,
    });
    const bus = new NexusEventBus(ipc);

    const session = await rt.spawn("smoke", {
      role: "smoke",
      command: "codex",
      cwd: process.cwd(),
      platform: "codex",
      waitForPush: true,
    });

    try {
      const before = await inboxCount(NEXUS_TEST_AGENT_ID);

      const turn = await rt.send(session, "reply with: pong");
      const results = await publishTurnToNexus({
        bus,
        sourceRole: NEXUS_TEST_AGENT_ID,
        targetRole: NEXUS_TEST_AGENT_ID,
        sessionId: session.id,
        turnId: turn.turnId,
        messages: turn.messages,
        result: turn.result,
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      const terminal = results.at(-1);
      expect(terminal?.ok).toBe(true);
      expect(typeof terminal?.messageId).toBe("string");

      // Every emitted event should carry an IPC message ID from the real
      // Nexus — proves the payload survived the HTTP round-trip, not just
      // that the local handler saw it.
      for (const r of results) {
        expect(r.ok).toBe(true);
        expect(r.messageId).toBeDefined();
      }

      const after = await inboxCount(NEXUS_TEST_AGENT_ID);
      expect(after - before).toBeGreaterThanOrEqual(results.length);
    } finally {
      await rt.close(session);
      bus.close();
    }
  }, 180_000);
});
