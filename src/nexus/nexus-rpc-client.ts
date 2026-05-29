import { z } from "zod";

export interface NexusRpcClientConfig {
  readonly url: string;
  readonly apiKey?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

const RpcEnvelopeSchema = z.object({
  jsonrpc: z.string().optional(),
  id: z.union([z.string(), z.number()]).optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

export class NexusRpcClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(config: NexusRpcClientConfig) {
    this.baseUrl = config.url.replace(/\/+$/, "");
    this.apiKey = config.apiKey === "" ? undefined : config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async call<T>(
    method: string,
    params: Readonly<Record<string, unknown>>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api/nfs/${encodeURIComponent(method)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey !== undefined ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Nexus RPC ${method} failed: HTTP ${response.status}`);
    }

    const envelope = RpcEnvelopeSchema.parse(await response.json());
    if (envelope.error !== undefined) {
      throw new Error(`Nexus RPC ${method} failed: ${JSON.stringify(envelope.error)}`);
    }
    return schema.parse(envelope.result);
  }
}
