import {
  type Agent,
  AgentSideConnection,
  type InitializeRequest,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import type { LaunchOverride, LaunchResult } from "./acp-runtime.js";

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

export interface DisconnectableHandlers {
  /**
   * Optional prompt handler. When provided, a turn COMPLETES (used by the
   * seq-continuity test). When omitted, prompt() never resolves so the only
   * way a turn/session ends is an exit trigger (used by the respawn tests,
   * which never send()).
   */
  readonly onPrompt?: (ctx: {
    readonly sessionId: string;
    readonly agentSide: AgentSideConnection;
  }) => Promise<{ stopReason: "end_turn" | "cancelled" | "error" | "max_tokens" }>;
}

/**
 * A LaunchOverride whose every spawned (in-process) agent exposes a manual
 * exit trigger. `onTrigger(cb)` is invoked once per launch with that launch's
 * trigger function, so a test can capture the Nth child's trigger as the
 * shared runtime spawns/respawns. Each launch gets a unique wire session id.
 */
export function makeDisconnectableLaunchOverride(handlers: DisconnectableHandlers = {}): {
  launchOverride: LaunchOverride;
  onTrigger: (
    cb: (
      trigger: (info: { exitCode?: number | null; signal?: NodeJS.Signals | null }) => void,
    ) => void,
  ) => void;
} {
  const triggerListeners: Array<
    (trigger: (info: { exitCode?: number | null; signal?: NodeJS.Signals | null }) => void) => void
  > = [];
  let wireCounter = 0;

  const launchOverride: LaunchOverride = async (): Promise<LaunchResult> => {
    const exitListeners: Array<
      (info: { exitCode?: number | null; signal?: NodeJS.Signals | null }) => void
    > = [];
    const toAgent = new TransformStream<Uint8Array, Uint8Array>();
    const toClient = new TransformStream<Uint8Array, Uint8Array>();
    const agentStream = ndJsonStream(toClient.writable, toAgent.readable);
    const clientStream = ndJsonStream(toAgent.writable, toClient.readable);
    const wireId = `wire-${wireCounter++}`;
    let agentSideRef: AgentSideConnection | null = null;
    const agent: Agent = {
      async initialize() {
        return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
      },
      async newSession() {
        return { sessionId: wireId };
      },
      async prompt(p) {
        if (handlers.onPrompt && agentSideRef) {
          return handlers.onPrompt({ sessionId: p.sessionId, agentSide: agentSideRef });
        }
        await new Promise(() => undefined);
        return { stopReason: "end_turn" };
      },
      async cancel() {},
      async authenticate() {
        return {};
      },
    };
    agentSideRef = new AgentSideConnection(() => agent, agentStream);
    const trigger = (info: { exitCode?: number | null; signal?: NodeJS.Signals | null }): void => {
      for (const l of exitListeners) l(info);
    };
    for (const cb of triggerListeners) cb(trigger);
    return {
      clientStream,
      dispose: async () => {},
      onExit: (listener) => exitListeners.push(listener),
    };
  };

  return {
    launchOverride,
    onTrigger: (cb) => {
      triggerListeners.push(cb);
    },
  };
}
