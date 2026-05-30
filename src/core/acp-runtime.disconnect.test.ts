import { describe, expect, test } from "bun:test";
import { type Agent, AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { AcpRuntime, type LaunchOverride, type LaunchResult } from "./acp-runtime.js";
import { AgentDisconnectedError } from "./agent-runtime.js";

function makeDisconnectableAgent(): {
  launchOverride: LaunchOverride;
  triggerExit: (info: { exitCode?: number | null; signal?: NodeJS.Signals | null }) => void;
} {
  const exitListeners: Array<
    (info: { exitCode?: number | null; signal?: NodeJS.Signals | null }) => void
  > = [];
  const launchOverride: LaunchOverride = async () => {
    const toAgent = new TransformStream<Uint8Array, Uint8Array>();
    const toClient = new TransformStream<Uint8Array, Uint8Array>();
    const agentStream = ndJsonStream(toClient.writable, toAgent.readable);
    const clientStream = ndJsonStream(toAgent.writable, toClient.readable);
    const agent: Agent = {
      async initialize() {
        return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
      },
      async newSession() {
        return { sessionId: `wire-${exitListeners.length}` };
      },
      async prompt() {
        await new Promise(() => undefined); // never resolves until disconnect
        return { stopReason: "end_turn" };
      },
      async cancel() {},
      async authenticate() {
        return {};
      },
    };
    void new AgentSideConnection(() => agent, agentStream);
    const result: LaunchResult = {
      clientStream,
      dispose: async () => {},
      onExit: (listener) => exitListeners.push(listener),
    };
    return result;
  };
  return {
    launchOverride,
    triggerExit: (info) => {
      for (const l of exitListeners) l(info);
    },
  };
}

describe("AgentDisconnectedError", () => {
  test("carries session/role/exit info and a readable message", () => {
    const err = new AgentDisconnectedError({
      sessionId: "grove-coder-0--abc",
      role: "coder",
      exitCode: null,
      signal: "SIGKILL",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.info.sessionId).toBe("grove-coder-0--abc");
    expect(err.info.role).toBe("coder");
    expect(err.info.signal).toBe("SIGKILL");
    expect(err.message).toContain("coder");
    expect(err.message).toContain("grove-coder-0--abc");
  });
});

describe("AcpRuntime disconnect detection", () => {
  test("onDisconnect fires once with AgentDisconnectedError on unexpected exit", async () => {
    const { launchOverride, triggerExit } = makeDisconnectableAgent();
    const rt = new AcpRuntime({ launchOverride });
    const session = await rt.spawn("coder", {
      role: "coder",
      command: "codex",
      cwd: process.cwd(),
    });

    const seen: AgentDisconnectedError[] = [];
    rt.onDisconnect(session, (err) => seen.push(err));

    triggerExit({ exitCode: null, signal: "SIGKILL" });
    await new Promise((r) => setTimeout(r, 10));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(AgentDisconnectedError);
    expect(seen[0]?.info.role).toBe("coder");
    expect(seen[0]?.info.signal).toBe("SIGKILL");
    expect((await rt.listSessions())[0]?.status).toBe("crashed");
  });

  test("onDisconnect does NOT fire on intentional close()", async () => {
    const { launchOverride, triggerExit } = makeDisconnectableAgent();
    const rt = new AcpRuntime({ launchOverride });
    const session = await rt.spawn("coder", {
      role: "coder",
      command: "codex",
      cwd: process.cwd(),
    });
    const seen: AgentDisconnectedError[] = [];
    rt.onDisconnect(session, (err) => seen.push(err));

    await rt.close(session);
    triggerExit({ exitCode: 0, signal: null }); // exit AFTER close — must be ignored
    await new Promise((r) => setTimeout(r, 10));

    expect(seen).toHaveLength(0);
  });

  test("an in-flight send() settles with stopReason=error when the agent dies mid-turn", async () => {
    const { launchOverride, triggerExit } = makeDisconnectableAgent();
    const rt = new AcpRuntime({ launchOverride });
    const session = await rt.spawn("coder", {
      role: "coder",
      command: "codex",
      cwd: process.cwd(),
    });

    // prompt() in the stub never resolves, so this turn stays in flight.
    const turn = await rt.send(session, "do work");

    // Let the send chain reach connection.prompt() before the process dies.
    await new Promise((r) => setTimeout(r, 10));
    triggerExit({ exitCode: null, signal: "SIGKILL" });

    const result = await turn.result;
    expect(result.stopReason).toBe("error");
    expect((await rt.listSessions())[0]?.status).toBe("crashed");
  });
});
