import { AcpRuntime, type AcpRuntimeOptions } from "./acp-runtime.js";
import type { AgentRuntime } from "./agent-runtime.js";

export interface SelectRuntimeOptions {
  readonly env?: { readonly GROVE_RUNTIME?: string | undefined };
  readonly acpx?: { agent?: string; logDir?: string };
  readonly acp?: AcpRuntimeOptions;
}

export function selectRuntime(options: SelectRuntimeOptions = {}): AgentRuntime {
  const flag = options.env?.GROVE_RUNTIME ?? process.env.GROVE_RUNTIME;
  const normalized = flag?.trim().toLowerCase();
  if (normalized === undefined || normalized === "" || normalized === "acp") {
    return new AcpRuntime(options.acp);
  }
  throw new Error(
    `[select-runtime] GROVE_RUNTIME=${flag} no longer supported; only "acp" is valid`,
  );
}
