import { describe, expect, test } from "bun:test";
import {
  type Agent,
  AgentSideConnection,
  ndJsonStream,
  type RequestPermissionRequest,
} from "@agentclientprotocol/sdk";
import { AcpRuntime, type LaunchOverride } from "./acp-runtime.js";

interface AgentStubHandlers {
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
      async newSession() {
        return { sessionId: `wire-${Date.now()}` };
      },
      async prompt(p) {
        if (handlers.onPrompt && ref.agentSide) {
          return handlers.onPrompt({ sessionId: p.sessionId, agentSide: ref.agentSide });
        }
        return { stopReason: "end_turn" };
      },
      async cancel() {},
      async authenticate() {
        return {};
      },
    };
    const agentSide = new AgentSideConnection(() => agent, agentStream);
    ref.agentSide = agentSide;
    handlers.capture?.(ref);

    return {
      clientStream,
      dispose: async () => {},
    };
  };
  return { launchOverride, ref };
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
