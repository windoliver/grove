import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Agent,
  type InitializeRequest,
  RequestError,
  type RequestPermissionRequest,
} from "@agentclientprotocol/sdk";
import { AcpRuntime, type AcpRuntimeEvent } from "./acp-runtime.js";
import { makeInProcessAgent } from "./acpx-test-support.js";

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
  test("advertises filesystem and terminal client capabilities", async () => {
    let captured: InitializeRequest | undefined;
    const { launchOverride } = makeInProcessAgent({
      onInitialize(p) {
        captured = p;
      },
    });
    const rt = new AcpRuntime({ launchOverride });
    const session = await rt.spawn("coder", {
      role: "coder",
      command: "codex",
      cwd: process.cwd(),
    });

    expect(captured?.clientCapabilities?.fs?.readTextFile).toBe(true);
    expect(captured?.clientCapabilities?.fs?.writeTextFile).toBe(true);
    expect(captured?.clientCapabilities?.terminal).toBe(true);
    await rt.close(session);
  });

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
  test("serves ACP filesystem and terminal requests from the client", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-acp-client-"));
    const filePath = join(dir, "hello.txt");
    const { launchOverride } = makeInProcessAgent({
      async onPrompt({ sessionId, agentSide }) {
        await agentSide.writeTextFile({ sessionId, path: filePath, content: "hi\nthere\n" });
        const read = await agentSide.readTextFile({ sessionId, path: filePath, line: 2, limit: 1 });
        expect(read.content).toBe("there\n");

        const terminal = await agentSide.createTerminal({
          sessionId,
          command: "sh",
          args: ["-lc", "printf terminal-ok"],
          cwd: dir,
        });
        const exit = await terminal.waitForExit();
        expect(exit.exitCode).toBe(0);
        const output = await terminal.currentOutput();
        expect(output.output).toBe("terminal-ok");
        await terminal.release();

        return { stopReason: "end_turn" };
      },
    });
    const rt = new AcpRuntime({ launchOverride });
    const session = await rt.spawn("coder", {
      role: "coder",
      command: "codex",
      cwd: dir,
    });

    const turn = await rt.send(session, "exercise client capabilities");
    expect((await turn.result).stopReason).toBe("end_turn");
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("hi\nthere\n");
    await rt.close(session);
  });

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

  test("marks the session idle after a prompt result", async () => {
    const promptStarted = deferred();
    const finishPrompt = deferred<{ stopReason: "end_turn" }>();
    const { launchOverride } = makeInProcessAgent({
      async onPrompt() {
        promptStarted.resolve();
        return await finishPrompt.promise;
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

    expect((await rt.listSessions())[0]?.status).toBe("running");

    finishPrompt.resolve({ stopReason: "end_turn" });
    await turn.result;

    expect((await rt.listSessions())[0]?.status).toBe("idle");
    await rt.close(session);
  });

  test("marks the session crashed after a prompt error", async () => {
    const { launchOverride } = makeInProcessAgent({
      async onPrompt() {
        throw new RequestError(-32603, "Internal error", {
          message: "adapter connection closed",
        });
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
    const current = (await rt.listSessions())[0];

    expect(result.stopReason).toBe("error");
    expect(current?.status).toBe("crashed");
    expect(current?.statusMessage).toBe("adapter connection closed");
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

  test("close is bounded when an adapter ignores cancel", async () => {
    const promptStarted = deferred();
    let disposed = false;
    const { launchOverride } = makeInProcessAgent({
      async onPrompt() {
        promptStarted.resolve();
        await new Promise(() => undefined);
        return { stopReason: "cancelled" };
      },
      onDispose() {
        disposed = true;
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
    const start = Date.now();
    await rt.close(session);

    expect(Date.now() - start).toBeLessThan(3_000);
    expect(disposed).toBe(true);
    expect(await rt.listSessions()).toEqual([]);

    void turn.result;
  });

  test("surfaces ACP RequestError data messages on prompt failure", async () => {
    const { launchOverride } = makeInProcessAgent({
      async onPrompt() {
        throw new RequestError(-32603, "Internal error", {
          message: "Your access token could not be refreshed. Please log out and sign in again.",
        });
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

    expect(result.stopReason).toBe("error");
    expect(result.error?.message).toBe(
      "Your access token could not be refreshed. Please log out and sign in again.",
    );
    await rt.close(session);
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
