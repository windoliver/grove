/**
 * Shared Nexus IPC client for sending messages via the Nexus IPC API.
 *
 * Consolidates the duplicate POST /api/v2/ipc/send calls that previously
 * existed in both NexusEventBus and NexusWsBridge (Issue #165 / 5A).
 *
 * Returns structured results with IPC message IDs for handoff tracking.
 */

import { debugLog } from "../tui/debug-log.js";

/** Result of an IPC send operation. */
export interface IpcSendResult {
  readonly ok: boolean;
  readonly messageId?: string | undefined;
  readonly error?: string | undefined;
}

/** Options for constructing a NexusIpcClient. */
export interface NexusIpcClientOptions {
  readonly nexusUrl: string;
  readonly apiKey: string;
}

export class NexusIpcClient {
  private readonly nexusUrl: string;
  private readonly apiKey: string;

  constructor(opts: NexusIpcClientOptions) {
    this.nexusUrl = opts.nexusUrl;
    this.apiKey = opts.apiKey;
  }

  /**
   * Send an IPC message from one agent to another via Nexus.
   *
   * Returns a structured result with the IPC message ID on success.
   * Never throws — errors are returned in the result.
   */
  async send(
    sender: string,
    recipient: string,
    payload: Record<string, unknown>,
  ): Promise<IpcSendResult> {
    try {
      const resp = await fetch(`${this.nexusUrl}/api/v2/ipc/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ sender, recipient, type: "event", payload }),
      });

      if (!resp.ok) {
        const error = `IPC send failed: HTTP ${resp.status}`;
        debugLog("nexus-ipc", `SEND FAIL sender=${sender} recipient=${recipient} status=${resp.status}`);
        return { ok: false, error };
      }

      // Try to extract message_id from response
      let messageId: string | undefined;
      try {
        const body = (await resp.json()) as { message_id?: string };
        messageId = body.message_id;
      } catch {
        // Response may not be JSON — still a success
      }

      debugLog(
        "nexus-ipc",
        `SEND OK sender=${sender} recipient=${recipient} messageId=${messageId ?? "(none)"}`,
      );
      return { ok: true, messageId };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      debugLog("nexus-ipc", `SEND ERROR sender=${sender} recipient=${recipient} err=${error}`);
      return { ok: false, error };
    }
  }
}
