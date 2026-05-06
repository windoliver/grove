import { describe, expect, test } from "bun:test";
import {
  type Agent,
  AgentSideConnection,
  ndJsonStream,
  type RequestPermissionRequest,
} from "@agentclientprotocol/sdk";
import { AcpRuntime, type AcpRuntimeEvent, type LaunchOverride } from "./acp-runtime.js";

interface AgentStubHandlers {
  onNewSession?: (p: Parameters<Agent["newSession"]>[0]) => void;
  onCancel?: () => Promise<void> | void;
  onPrompt?: (p: {
    sessionId: string;
    agentSide: AgentSideConnection;
  }) => Promise<{ stopReason: "end_turn" | "cancelled" | "error" | "max_tokens" }>;
  capture?: (ref: { agentSide: AgentSideConnection | null }) => void;
}

function makeInProcessAgent(handlers: AgentStubHandlers = {}): {
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
      async initialize() {
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
      dispose: async () => undefined,
    };
  };
  return { launchOverride, ref };
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {
    /* assigned synchronously by Promise constructor */
  };
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("AcpRuntime.spawn", () => {
  test("initializes, creates a session, returns grove-formatted id", async () => {
    const { launchOverride } = makeInProcessAgent();
    const rt = new AcpRuntime({ launchOverride });
    const session = await rt.spawn("coder", {
      role: "coder",
      command: "codex",
      cwd: process.cwd(),
    });
    expect(session.role).toBe("coder");
    expect(session.status).toBe("running");
    expect(session.id).toMatch(/^grove-coder-\d+--[a-z0-9]+$/);
    await rt.close(session);
  });

  test("close removes the session from listSessions", async () => {
    const { launchOverride } = makeInProcessAgent();
    const rt = new AcpRuntime({ launchOverride });
    const session = await rt.spawn("coder", {
      role: "coder",
      command: "codex",
      cwd: process.cwd(),
    });
    expect((await rt.listSessions()).length).toBe(1);
    await rt.close(session);
    expect(await rt.listSessions()).toEqual([]);
  });

  test("forwards Grove identity env to MCP servers", async () => {
    let captured: Parameters<Agent["newSession"]>[0] | undefined;
    const { launchOverride } = makeInProcessAgent({
      onNewSession(p) {
        captured = p;
      },
    });
    const rt = new AcpRuntime({ launchOverride });
    const session = await rt.spawn("coder", {
      role: "coder",
      command: "codex",
      cwd: process.cwd(),
      env: {
        GROVE_SESSION_ID: "session-1",
        GROVE_ROUTING_TOKEN: "token-1",
      },
      mcpServers: [
        {
          name: "grove",
          command: "bun",
          args: ["run", "dist/mcp/serve.js"],
          env: { GROVE_DIR: "/tmp/project/.grove" },
        },
      ],
    });

    const server = captured?.mcpServers?.[0];
    expect(server?.name).toBe("grove");
    expect(server?.env).toContainEqual({ name: "GROVE_DIR", value: "/tmp/project/.grove" });
    expect(server?.env).toContainEqual({ name: "GROVE_SESSION_ID", value: "session-1" });
    expect(server?.env).toContainEqual({ name: "GROVE_ROUTING_TOKEN", value: "token-1" });
    expect(server?.env).toContainEqual({ name: "GROVE_AGENT_ID", value: session.id });
    expect(server?.env).toContainEqual({ name: "GROVE_AGENT_ROLE", value: "coder" });
    await rt.close(session);
  });

  test("does not forward Grove secrets to non-Grove MCP servers", async () => {
    let captured: Parameters<Agent["newSession"]>[0] | undefined;
    const { launchOverride } = makeInProcessAgent({
      onNewSession(p) {
        captured = p;
      },
    });
    const rt = new AcpRuntime({ launchOverride });
    const session = await rt.spawn("coder", {
      role: "coder",
      command: "codex",
      cwd: process.cwd(),
      env: {
        GROVE_SESSION_ID: "session-1",
        GROVE_ROUTING_TOKEN: "token-1",
        NEXUS_API_KEY: "sk-test",
      },
      mcpServers: [
        {
          name: "third-party",
          command: "third-party-mcp",
          env: { SAFE_VALUE: "ok" },
        },
      ],
    });

    const server = captured?.mcpServers?.[0];
    expect(server?.name).toBe("third-party");
    expect(server?.env).toContainEqual({ name: "SAFE_VALUE", value: "ok" });
    expect(server?.env).not.toContainEqual({ name: "GROVE_SESSION_ID", value: "session-1" });
    expect(server?.env).not.toContainEqual({ name: "GROVE_ROUTING_TOKEN", value: "token-1" });
    expect(server?.env).not.toContainEqual({ name: "NEXUS_API_KEY", value: "sk-test" });
    expect(server?.env).not.toContainEqual({ name: "GROVE_AGENT_ID", value: session.id });
    await rt.close(session);
  });
});

describe("AcpRuntime.send", () => {
  test("returns a turn; result resolves with stopReason=end_turn on successful prompt", async () => {
    const { launchOverride } = makeInProcessAgent({
      async onPrompt() {
        return { stopReason: "end_turn" };
      },
    });
    const rt = new AcpRuntime({ launchOverride });
    const session = await rt.spawn("coder", {
      role: "coder",
      command: "codex",
      cwd: process.cwd(),
    });
    const turn = await rt.send(session, "hello");
    const result = await turn.result;
    expect(result.stopReason).toBe("end_turn");
    await rt.close(session);
  });

  test("agent sessionUpdate notifications stream into the turn's messages", async () => {
    const { launchOverride } = makeInProcessAgent({
      async onPrompt({ sessionId, agentSide }) {
        await agentSide.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello" },
          },
        });
        await agentSide.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: " world" },
          },
        });
        return { stopReason: "end_turn" };
      },
    });
    const rt = new AcpRuntime({ launchOverride });
    const session = await rt.spawn("coder", {
      role: "coder",
      command: "codex",
      cwd: process.cwd(),
    });
    const turn = await rt.send(session, "hi");
    const chunks: string[] = [];
    const collect = (async () => {
      for await (const m of turn.messages) {
        if (m.kind === "text") chunks.push(m.text);
      }
    })();
    await turn.result;
    await collect;
    expect(chunks.join("")).toBe("hello world");
    await rt.close(session);
  });

  test("close cancels an in-flight prompt", async () => {
    const promptStarted = deferred();
    const cancelled = deferred();
    const { launchOverride } = makeInProcessAgent({
      async onPrompt() {
        promptStarted.resolve();
        await cancelled.promise;
        return { stopReason: "cancelled" };
      },
      onCancel() {
        cancelled.resolve();
      },
    });
    const rt = new AcpRuntime({ launchOverride });

    const session = await rt.spawn("coder", {
      role: "coder",
      command: "codex",
      cwd: process.cwd(),
    });

    const turn = await rt.send(session, "slow task");
    await promptStarted.promise;
    await rt.close(session);

    const result = await turn.result;
    expect(result.stopReason).toBe("cancelled");
  });

  test("emits direct ACP messages and results to the event sink", async () => {
    const { launchOverride } = makeInProcessAgent({
      async onPrompt({ sessionId, agentSide }) {
        await agentSide.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "visible" },
          },
        });
        return { stopReason: "end_turn" };
      },
    });
    const events: AcpRuntimeEvent[] = [];
    const rt = new AcpRuntime({ launchOverride, eventSink: (event) => events.push(event) });
    const session = await rt.spawn("coder", {
      role: "coder",
      command: "codex",
      cwd: process.cwd(),
    });
    const turn = await rt.send(session, "hi");
    await turn.result;

    expect(events.map((event) => event.kind)).toEqual(["message", "result"]);
    expect(events.every((event) => event.sessionId === session.id)).toBe(true);
    expect(events[0]?.turnId).toBe(turn.turnId);
    if (events[0]?.kind === "message") {
      expect(events[0].message.kind).toBe("text");
    }
    await rt.close(session);
  });
});

describe("AcpRuntime permission flow", () => {
  test("requestPermission routes to resolver and decision returns to agent", async () => {
    const seen: string[] = [];
    const { launchOverride } = makeInProcessAgent({
      async onPrompt({ sessionId, agentSide }) {
        const resp = await agentSide.requestPermission({
          sessionId,
          toolCall: {
            toolCallId: "tc1",
            title: "Run rm -rf /",
            kind: "execute",
            status: "pending",
          },
          options: [
            { optionId: "y", name: "Allow", kind: "allow_once" },
            { optionId: "n", name: "Deny", kind: "reject_once" },
          ],
        });
        return {
          stopReason: resp.outcome.outcome === "selected" ? "end_turn" : "cancelled",
        };
      },
    });
    const resolver = {
      async resolve(req: RequestPermissionRequest) {
        seen.push(req.toolCall.title ?? "");
        return { outcome: { outcome: "selected" as const, optionId: "y" } };
      },
    };
    const rt = new AcpRuntime({ launchOverride, permissionResolver: resolver });
    const session = await rt.spawn("coder", {
      role: "coder",
      command: "codex",
      cwd: process.cwd(),
    });
    const turn = await rt.send(session, "delete everything");
    const res = await turn.result;
    expect(seen).toEqual(["Run rm -rf /"]);
    expect(res.stopReason).toBe("end_turn");
    await rt.close(session);
  });
});
