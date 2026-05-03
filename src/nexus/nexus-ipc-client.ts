/**
 * Shared Nexus IPC client for sending messages via the Nexus kernel-VFS RPC.
 *
 * Migrated from the removed `/api/v2/ipc/send` route to the post-PR-#3912
 * RPC surface: messages are written into the recipient's inbox at
 * `/ipc/{recipient}/inbox/{message_id}.json` via `POST /api/nfs/sys_write`.
 * Subscribers consume those writes through `/api/v2/events/stream` with a
 * matching path pattern (handled by NexusWsBridge).
 *
 * Returns structured results with IPC message IDs for handoff tracking.
 */

import { debugLog } from "../tui/debug-log.js";

/** Result of an IPC send operation. */
export interface IpcSendResult {
  readonly ok: boolean;
  readonly messageId?: string | undefined;
  readonly error?: string | undefined;
  /**
   * True when the failure is an infrastructure issue (endpoint not found,
   * connection refused) rather than a delivery-level rejection. Callers
   * should NOT dead-letter handoffs on infrastructure errors — the message
   * was never attempted, not rejected.
   */
  readonly infrastructureError?: boolean | undefined;
}

/** Options for constructing a NexusIpcClient. */
export interface NexusIpcClientOptions {
  readonly nexusUrl: string;
  readonly apiKey: string;
}

/** How long to cache a transient IPC failure before retrying (ms). */
const TRANSIENT_BACKOFF_MS = 30_000;

export class NexusIpcClient {
  private readonly nexusUrl: string;
  private readonly apiKey: string;
  /**
   * Endpoint availability state:
   * - undefined: unknown (first call)
   * - true: confirmed reachable
   * - false: permanently unavailable (404/405 — endpoint doesn't exist)
   */
  private endpointAvailable: boolean | undefined;
  /** Timestamp of last transient failure. Used for backoff, not permanent caching. */
  private transientFailureAt: number | undefined;

  constructor(opts: NexusIpcClientOptions) {
    this.nexusUrl = opts.nexusUrl;
    this.apiKey = opts.apiKey;
  }

  /**
   * Send an IPC message from one agent to another via Nexus.
   *
   * Returns a structured result with the IPC message ID on success.
   * Never throws — errors are returned in the result.
   *
   * Infrastructure errors (404, connection refused) set ok=false but also
   * set `infrastructureError=true` so callers can distinguish "IPC endpoint
   * doesn't exist" from "message was rejected by the IPC service."
   */
  async send(
    sender: string,
    recipient: string,
    payload: Record<string, unknown>,
  ): Promise<IpcSendResult> {
    // Skip if we've determined the endpoint permanently doesn't exist (404/405).
    if (this.endpointAvailable === false) {
      return {
        ok: false,
        error: "IPC endpoint unavailable (permanent 404/405)",
        infrastructureError: true,
      };
    }

    // Backoff on transient failures (502/503/network) — retry after TRANSIENT_BACKOFF_MS.
    if (
      this.transientFailureAt !== undefined &&
      Date.now() - this.transientFailureAt < TRANSIENT_BACKOFF_MS
    ) {
      return { ok: false, error: "IPC endpoint transient backoff", infrastructureError: true };
    }

    try {
      const messageId = globalThis.crypto?.randomUUID?.() ?? `msg-${Date.now()}`;
      const envelope = JSON.stringify({
        message_id: messageId,
        sender,
        recipient,
        type: "event",
        payload,
        timestamp: new Date().toISOString(),
      });
      const buf = Buffer.from(envelope, "utf8").toString("base64");
      const resp = await fetch(`${this.nexusUrl}/api/nfs/sys_write`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "sys_write",
          params: { path: `/ipc/${recipient}/inbox/${messageId}.json`, buf },
          id: 1,
        }),
      });

      if (!resp.ok) {
        const error = `IPC send failed: HTTP ${resp.status}`;
        debugLog(
          "nexus-ipc",
          `SEND FAIL sender=${sender} recipient=${recipient} status=${resp.status}`,
        );
        // 404/405 = endpoint doesn't exist on this Nexus version → permanent disable
        const isPermanent = resp.status === 404 || resp.status === 405;
        // 429/5xx/auth = retryable/infrastructure, NOT a delivery rejection.
        // Only a 2xx success followed by a delivery-level rejection from the
        // IPC service (future: explicit rejected status) should dead-letter.
        // All non-2xx failures are infrastructure by definition — the message
        // was never accepted for delivery.
        const isInfraOrRetryable = !isPermanent;
        if (isPermanent) {
          this.endpointAvailable = false;
        } else if (resp.status >= 500 || resp.status === 429) {
          this.transientFailureAt = Date.now();
        }
        return { ok: false, error, infrastructureError: isPermanent || isInfraOrRetryable };
      }

      this.endpointAvailable = true;
      this.transientFailureAt = undefined; // clear backoff on success

      debugLog(
        "nexus-ipc",
        `SEND OK sender=${sender} recipient=${recipient} messageId=${messageId}`,
      );
      return { ok: true, messageId };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      debugLog("nexus-ipc", `SEND ERROR sender=${sender} recipient=${recipient} err=${error}`);
      // Network errors (connection refused, DNS failure) = transient infrastructure
      this.transientFailureAt = Date.now();
      return { ok: false, error, infrastructureError: true };
    }
  }
}
