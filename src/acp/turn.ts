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
  private cancelSucceeded = false;
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
   * attempt so we never double-send cancel to the underlying transport.
   *
   * Retryable: if `cancelFn` rejects (transient IPC failure, stdin race), the
   * rejection is re-thrown and `cancelSucceeded` stays false — subsequent
   * callers get a fresh attempt.
   *
   * Idempotent after success: once `cancelFn` has resolved, further calls are
   * no-ops. Also short-circuits if the turn's result has already settled.
   */
  async cancel(): Promise<void> {
    if (this.cancelSucceeded) return;
    if (this.resultSettled) return;
    if (this.pendingCancel !== null) return this.pendingCancel;

    const attempt = (async () => {
      try {
        await this.cancelFn();
        this.cancelSucceeded = true;
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
