/**
 * Integration test: AcpxRuntime end-to-end against a real `acpx` + agent CLI.
 *
 * Gated on `AcpxRuntime.isAvailable()` so the suite passes on machines
 * without acpx installed. Complements `acpx-runtime.component.test.ts`
 * (which covers send serialization and basic reply) by asserting the
 * typed-message contract — Message unions, terminal Result stopReason,
 * and that the stream is an async iterable rather than a raw string.
 */

import { describe, expect, test } from "bun:test";
import type { Message, StopReason } from "../acp/types.js";
import { AcpxRuntime } from "./acpx-runtime.js";

const TERMINAL_STOP_REASONS: StopReason[] = ["end_turn", "max_tokens", "cancelled", "error"];

describe("AcpxRuntime integration (real acpx)", () => {
  test("send yields typed Messages and a terminal Result", async () => {
    const rt = new AcpxRuntime();
    if (!(await rt.isAvailable())) {
      console.warn("[skip] acpx not installed — integration test skipped");
      return;
    }

    const session = await rt.spawn("smoke", {
      role: "smoke",
      command: "codex",
      cwd: process.cwd(),
      platform: "codex",
      waitForPush: true,
    });

    try {
      const turn = await rt.send(session, "reply with: pong");
      expect(turn.sessionId).toBe(session.id);
      expect(typeof turn.turnId).toBe("string");

      const collected: Message[] = [];
      for await (const m of turn.messages) {
        // Every Message must have a turnId string (discriminated union invariant).
        expect(typeof m.turnId).toBe("string");
        collected.push(m);
      }

      expect(collected.length).toBeGreaterThan(0);

      // At least one kind should be a real provider output — text, thinking,
      // tool_call, token_usage, permission_request, or raw (future-compat).
      const knownKinds = new Set([
        "text",
        "thinking",
        "tool_call",
        "token_usage",
        "permission_request",
        "raw",
      ]);
      for (const m of collected) {
        expect(knownKinds.has(m.kind)).toBe(true);
      }

      const r = await turn.result;
      expect(r.turnId).toBe(turn.turnId);
      // Accept any known canonical stopReason (non-canonical strings are
      // allowed by the StopReason type via the `(string & {})` escape but a
      // real codex turn should land in the canonical set).
      const canonical = new Set<string>(TERMINAL_STOP_REASONS);
      expect(canonical.has(r.stopReason as string)).toBe(true);
    } finally {
      await rt.close(session);
    }
  }, 120_000);
});
