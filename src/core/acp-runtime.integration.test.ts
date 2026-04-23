import { afterAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { resolveAcpLaunch } from "./acp-launch.js";
import { AcpRuntime } from "./acp-runtime.js";

function codexLaunchable(): boolean {
  try {
    resolveAcpLaunch("codex");
  } catch {
    return false;
  }
  return Boolean(process.env.OPENAI_API_KEY) || Boolean(process.env.CODEX_API_KEY);
}

function claudeLaunchable(): boolean {
  try {
    resolveAcpLaunch("claude");
  } catch {
    return false;
  }
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function geminiLaunchable(): boolean {
  try {
    resolveAcpLaunch("gemini");
  } catch {
    return false;
  }
  try {
    execSync("gemini --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const codexOrSkip = codexLaunchable() ? test : test.skip;
const claudeOrSkip = claudeLaunchable() ? test : test.skip;
const geminiOrSkip = geminiLaunchable() ? test : test.skip;

describe("AcpRuntime integration (codex)", () => {
  const runtime = new AcpRuntime();

  afterAll(async () => {
    for (const s of await runtime.listSessions()) {
      await runtime.close(s);
    }
  });

  codexOrSkip(
    "spawn + send + result",
    async () => {
      const session = await runtime.spawn("coder", {
        role: "coder",
        command: "codex",
        cwd: "/tmp",
        platform: "codex",
      });
      const turn = await runtime.send(
        session,
        "reply with exactly the word HELLO and nothing else",
      );
      const collected: string[] = [];
      for await (const m of turn.messages) {
        if (m.kind === "text") collected.push(m.text);
      }
      const res = await turn.result;
      expect(res.stopReason).toBe("end_turn");
      expect(collected.join("")).toContain("HELLO");
    },
    60_000,
  );

  codexOrSkip(
    "cancel mid-turn produces stopReason=cancelled",
    async () => {
      const session = await runtime.spawn("coder", {
        role: "coder",
        command: "codex",
        cwd: "/tmp",
        platform: "codex",
      });
      const turn = await runtime.send(session, "count from 1 to 1000 very slowly");
      setTimeout(() => {
        void turn.cancel();
      }, 500);
      const res = await turn.result;
      expect(res.stopReason).toBe("cancelled");
    },
    60_000,
  );
});

describe("AcpRuntime integration (claude)", () => {
  const runtime = new AcpRuntime();
  afterAll(async () => {
    for (const s of await runtime.listSessions()) await runtime.close(s);
  });

  claudeOrSkip(
    "spawn + send + result",
    async () => {
      const session = await runtime.spawn("coder", {
        role: "coder",
        command: "claude",
        cwd: "/tmp",
        platform: "claude-code",
      });
      const turn = await runtime.send(session, "reply with exactly the word HELLO");
      const text: string[] = [];
      for await (const m of turn.messages) {
        if (m.kind === "text") text.push(m.text);
      }
      const res = await turn.result;
      expect(res.stopReason).toBe("end_turn");
      expect(text.join("")).toContain("HELLO");
    },
    60_000,
  );
});

describe("AcpRuntime integration (gemini)", () => {
  const runtime = new AcpRuntime();
  afterAll(async () => {
    for (const s of await runtime.listSessions()) await runtime.close(s);
  });

  geminiOrSkip(
    "spawn + send + result",
    async () => {
      const session = await runtime.spawn("coder", {
        role: "coder",
        command: "gemini",
        cwd: "/tmp",
        platform: "gemini",
      });
      const turn = await runtime.send(session, "reply with exactly the word HELLO");
      const text: string[] = [];
      for await (const m of turn.messages) {
        if (m.kind === "text") text.push(m.text);
      }
      const res = await turn.result;
      expect(res.stopReason).toBe("end_turn");
      expect(text.join("")).toContain("HELLO");
    },
    60_000,
  );
});
