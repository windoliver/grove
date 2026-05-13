import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTuiStrategy } from "./tui.js";

const testDirs: string[] = [];

function makeQueuePath(): string {
  const dir = join(tmpdir(), `ask-user-tui-${Date.now()}-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  testDirs.push(dir);
  return join(dir, "queue.jsonl");
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createTuiStrategy", () => {
  test("ignores stale answers written before this question", async () => {
    const queuePath = makeQueuePath();
    const originalRandomUUID = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: () => "fixed-question-id",
    });
    appendFileSync(
      queuePath,
      `${JSON.stringify({ type: "answer", id: "fixed-question-id", answer: "stale" })}\n`,
    );
    const strategy = createTuiStrategy({ queuePath, pollIntervalMs: 5, timeoutMs: 25 });

    try {
      const answer = await strategy.answer({ question: "Pick one", options: ["default"] });

      expect(answer).toBe("default");
    } finally {
      Object.defineProperty(crypto, "randomUUID", {
        configurable: true,
        value: originalRandomUUID,
      });
    }
  });

  test("observes answers appended immediately after the question write", async () => {
    const queuePath = makeQueuePath();
    const strategy = createTuiStrategy({
      queuePath,
      pollIntervalMs: 5,
      timeoutMs: 50,
      afterQuestionWrite: (id) => {
        appendFileSync(queuePath, `${JSON.stringify({ type: "answer", id, answer: "ready" })}\n`);
      },
    });

    const answer = await strategy.answer({ question: "Ready?", options: ["default"] });

    expect(answer).toBe("ready");
  });
});
