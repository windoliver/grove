import { describe, expect, test } from "bun:test";
import type { SpawnFn } from "./agent.js";
import { createAgentStrategy } from "./agent.js";

const DEFAULT_AGENT_CONFIG = {
  command: "acpx",
  args: ["--approve-all", "claude"],
  timeoutMs: 60_000,
};

function mockSpawn(stdout: string, exitCode = 0): SpawnFn {
  return async () => ({ stdout, exitCode });
}

function failingSpawn(error: Error): SpawnFn {
  return async () => {
    throw error;
  };
}

describe("createAgentStrategy", () => {
  test("returns answer from subprocess", async () => {
    const strategy = await createAgentStrategy(DEFAULT_AGENT_CONFIG, mockSpawn("Use approach A"));
    const answer = await strategy.answer({ question: "Which approach?" });
    expect(answer).toBe("Use approach A");
  });

  test("trims whitespace from stdout", async () => {
    const strategy = await createAgentStrategy(DEFAULT_AGENT_CONFIG, mockSpawn("  trimmed  \n"));
    const answer = await strategy.answer({ question: "test" });
    expect(answer).toBe("trimmed");
  });

  test("passes question and options in command", async () => {
    let capturedCmd: string[] = [];
    const capturingSpawn: SpawnFn = async (cmd) => {
      capturedCmd = cmd;
      return { stdout: "answer", exitCode: 0 };
    };

    const strategy = await createAgentStrategy(DEFAULT_AGENT_CONFIG, capturingSpawn);
    await strategy.answer({
      question: "Which DB?",
      options: ["Postgres", "MySQL"],
    });

    expect(capturedCmd[0]).toBe("acpx");
    expect(capturedCmd[1]).toBe("--approve-all");
    expect(capturedCmd[2]).toBe("claude");
    // biome-ignore lint/style/noNonNullAssertion: index 3 is always the prompt arg
    const prompt = capturedCmd[3]!;
    expect(prompt).toContain("Which DB?");
    expect(prompt).toContain("Postgres, MySQL");
  });

  test("passes timeout to spawn", async () => {
    let capturedTimeout = 0;
    const capturingSpawn: SpawnFn = async (_cmd, opts) => {
      capturedTimeout = opts.timeout;
      return { stdout: "answer", exitCode: 0 };
    };

    const strategy = await createAgentStrategy(
      { ...DEFAULT_AGENT_CONFIG, timeoutMs: 5000 },
      capturingSpawn,
    );
    await strategy.answer({ question: "test" });

    expect(capturedTimeout).toBe(5000);
  });

  test("throws on non-zero exit code", async () => {
    const strategy = await createAgentStrategy(DEFAULT_AGENT_CONFIG, mockSpawn("", 1));
    await expect(strategy.answer({ question: "test" })).rejects.toThrow(
      "Agent process exited with code 1",
    );
  });

  test("throws on empty stdout", async () => {
    const strategy = await createAgentStrategy(DEFAULT_AGENT_CONFIG, mockSpawn(""));
    await expect(strategy.answer({ question: "test" })).rejects.toThrow(
      "Agent returned empty response",
    );
  });

  test("propagates spawn errors", async () => {
    const strategy = await createAgentStrategy(
      DEFAULT_AGENT_CONFIG,
      failingSpawn(new Error("spawn failed")),
    );
    await expect(strategy.answer({ question: "test" })).rejects.toThrow("spawn failed");
  });

  test("strategy name is 'agent'", async () => {
    const strategy = await createAgentStrategy(DEFAULT_AGENT_CONFIG, mockSpawn("x"));
    expect(strategy.name).toBe("agent");
  });
});
