/**
 * AcpxTurn — owns a single prompt's message stream and final result.
 * Constructed by AcpxRuntime from the acpx child's stdout Readable.
 */

import type { Readable } from "node:stream";
import { AcpParser } from "./parser.js";
import type { AcpxTurn, Message, Result } from "./types.js";

export class AcpxTurnImpl implements AcpxTurn {
  readonly sessionId: string;
  readonly turnId: string;
  readonly messages: AsyncIterable<Message>;
  readonly result: Promise<Result>;
  private readonly cancelFn: () => Promise<void>;
  private resultSettled = false;
  private pendingCancel: Promise<void> | null = null;

  constructor(opts: {
    sessionId: string;
    turnId: string;
    stdout: Readable;
    cancelFn: () => Promise<void>;
  }) {
    this.sessionId = opts.sessionId;
    this.turnId = opts.turnId;
    this.cancelFn = opts.cancelFn;
    const parser = new AcpParser({
      sessionId: opts.sessionId,
      turnId: opts.turnId,
      stream: opts.stdout,
    });
    this.messages = parser.messages;
    this.result = parser.result;
    // Track whether the turn has finished naturally so cancel() can short-circuit.
    this.result.then(
      () => {
        this.resultSettled = true;
      },
      () => {
        this.resultSettled = true;
      },
    );
  }

  /**
   * Cancel the in-flight turn.
   *
   * Single-flight: concurrent callers share the same in-flight cancellation
   * attempt so we never double-send cancel to the underlying transport during
   * a single call "wave".
   *
   * Retryable until the turn settles: a successful `cancelFn()` resolution is
   * only a "cancel requested", not a guaranteed "cancel confirmed" — the
   * provider may ignore it. Callers can re-invoke `cancel()` to re-send until
   * the turn's result arrives (at which point this becomes a no-op). If
   * `cancelFn` rejects, the rejection propagates and the next caller still
   * gets a fresh attempt.
   */
  async cancel(): Promise<void> {
    if (this.resultSettled) return;
    if (this.pendingCancel !== null) return this.pendingCancel;

    const attempt = (async () => {
      try {
        await this.cancelFn();
      } finally {
        this.pendingCancel = null;
      }
    })();
    this.pendingCancel = attempt;
    return attempt;
  }

  async close(): Promise<void> {
    // Parser closes when stdout EOFs; nothing extra to release here.
  }
}
