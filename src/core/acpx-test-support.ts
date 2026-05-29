import {
  type Agent,
  AgentSideConnection,
  type InitializeRequest,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import type { LaunchOverride } from "./acp-runtime.js";

export interface AgentStubHandlers {
  onInitialize?: (p: InitializeRequest) => void;
  onNewSession?: (p: Parameters<Agent["newSession"]>[0]) => void;
  onCancel?: () => Promise<void> | void;
  onPrompt?: (p: {
    sessionId: string;
    agentSide: AgentSideConnection;
  }) => Promise<{ stopReason: "end_turn" | "cancelled" | "error" | "max_tokens" }>;
  onDispose?: () => Promise<void> | void;
  capture?: (ref: { agentSide: AgentSideConnection | null }) => void;
}

export function makeInProcessAgent(handlers: AgentStubHandlers = {}): {
  launchOverride: LaunchOverride;
  ref: { agentSide: AgentSideConnection | null };
} {
  const ref: { agentSide: AgentSideConnection | null } = { agentSide: null };
  const launchOverride: LaunchOverride = async () => {
    const toAgent = new TransformStream<Uint8Array, Uint8Array>();
    const toClient = new TransformStream<Uint8Array, Uint8Array>();
    const agentStream = ndJsonStream(toClient.writable, toAgent.readable);
    const clientStream = ndJsonStream(toAgent.writable, toClient.readable);

    const agent: Agent = {
      async initialize(p) {
        handlers.onInitialize?.(p);
        return {
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: [],
        };
      },
      async newSession(p) {
        handlers.onNewSession?.(p);
        return { sessionId: `wire-${Date.now()}` };
      },
      async prompt(p) {
        if (handlers.onPrompt && ref.agentSide) {
          return handlers.onPrompt({ sessionId: p.sessionId, agentSide: ref.agentSide });
        }
        return { stopReason: "end_turn" };
      },
      async cancel() {
        await handlers.onCancel?.();
      },
      async authenticate() {
        return {};
      },
    };
    const agentSide = new AgentSideConnection(() => agent, agentStream);
    ref.agentSide = agentSide;
    handlers.capture?.(ref);

    return {
      clientStream,
      dispose: async () => {
        await handlers.onDispose?.();
      },
    };
  };
  return { launchOverride, ref };
}

/** Convenience: just the launchOverride, for tests that don't need the agent ref. */
export function makeInProcessLaunchOverride(handlers?: AgentStubHandlers): LaunchOverride {
  return makeInProcessAgent(handlers).launchOverride;
}
