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
   * Retryable: if `cancelFn` throws (transient IPC failure, stdin race), the
   * error is re-thrown and the turn is NOT marked cancelled — callers can
   * retry. Successful cancels are idempotent: once the underlying cancel
   * transport has succeeded, further calls are no-ops.
   *
   * Short-circuits if the turn's result has already settled.
   */
  async cancel(): Promise<void> {
    if (this.cancelSucceeded) return;
    if (this.resultSettled) return;
    await this.cancelFn();
    this.cancelSucceeded = true;
  }

  async close(): Promise<void> {
    // Parser closes when stdout EOFs; nothing extra to release here.
  }
}
