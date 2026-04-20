/**
 * Drain an AcpxTurn and publish typed records through an EventBus.
 *
 * For every Message the publisher emits one `acp.message` GroveEvent. When
 * the turn resolves, it emits a terminal `acp.result` event. sessionId +
 * turnId are carried in the payload so consumers can correlate events per
 * turn without depending on delivery order.
 *
 * Iteration-ordered: publish happens as each message is pulled from the
 * async iterator, not after the whole stream is buffered. This keeps
 * downstream subscribers live with the agent's output.
 */

import type { Message, Result } from "../acp/types.js";
import type { EventBus, GroveEvent, PublishResult } from "../core/event-bus.js";
import { getProcessInstanceId } from "../core/process-instance.js";

export interface PublishTurnOptions {
  readonly bus: EventBus;
  readonly sourceRole: string;
  readonly targetRole: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly messages: AsyncIterable<Message>;
  readonly result: Promise<Result>;
  /**
   * Stable per-process identifier. Embedded into payload.sourceInstance
   * so consumers can dedupe SSE loopback without relying on role-name
   * equality — two processes that share a Nexus and reuse the same role
   * name (e.g. both spawning "coder") must see each other's events, and
   * only drop the self-loop of their own emissions. Defaults to
   * `getProcessInstanceId()` so every published event carries a marker
   * and cross-process same-role traffic never collapses to "ambiguous".
   */
  readonly sourceInstance?: string;
}

/**
 * Returns one PublishResult per event emitted (N messages + 1 terminal
 * result). Callers can inspect `ok` / `messageId` to confirm real delivery
 * or detect transport failure — the publisher never throws on bus errors.
 */
export async function publishTurnToNexus(opts: PublishTurnOptions): Promise<PublishResult[]> {
  const results: PublishResult[] = [];

  // Always stamp sourceInstance. Default to the process-wide id so legacy
  // call sites that don't supply their own still participate in the strict
  // dedupe path and cannot be mistaken for "legacy publisher without marker".
  const sourceInstance = opts.sourceInstance ?? getProcessInstanceId();
  const maybeInstance = { sourceInstance };

  for await (const message of opts.messages) {
    const event: GroveEvent = {
      type: "acp.message",
      sourceRole: opts.sourceRole,
      targetRole: opts.targetRole,
      // `type` is repeated inside the payload so cross-process consumers
      // (NexusWsBridge SSE path) can discriminate the envelope. NexusEventBus
      // sends only `event.payload` over IPC, dropping the outer `event.type`.
      payload: {
        type: "acp.message",
        ...maybeInstance,
        sessionId: opts.sessionId,
        turnId: opts.turnId,
        message,
      },
      timestamp: new Date().toISOString(),
    };
    results.push(await opts.bus.publish(event));
  }

  const result = await opts.result;
  const terminal: GroveEvent = {
    type: "acp.result",
    sourceRole: opts.sourceRole,
    targetRole: opts.targetRole,
    payload: {
      type: "acp.result",
      ...maybeInstance,
      sessionId: opts.sessionId,
      turnId: opts.turnId,
      result,
    },
    timestamp: new Date().toISOString(),
  };
  results.push(await opts.bus.publish(terminal));

  return results;
}
