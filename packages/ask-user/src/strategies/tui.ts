/**
 * TUI answering strategy.
 *
 * Stores questions in a JSONL queue file and polls for answers,
 * enabling the TUI to display pending questions and relay user
 * responses back to the ask-user server.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AnswerStrategy, AskUserInput } from "../strategy.js";

/** Shape of a question entry written to the queue file. */
interface QuestionEntry {
  readonly type: "question";
  readonly id: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly context: string;
  readonly timestamp: string;
}

/** Shape of an answer entry read from the queue file. */
interface AnswerEntry {
  readonly type: "answer";
  readonly id: string;
  readonly answer: string;
}

/** Configuration for the TUI strategy. */
export interface TuiStrategyConfig {
  readonly queuePath?: string | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

/** Default timeout: 5 minutes. */
const DEFAULT_TIMEOUT_MS = 300_000;

/** Default poll interval: 1 second. */
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * Create a TUI answering strategy.
 *
 * Questions are appended to a JSONL file. The TUI (or another
 * process) reads that file, presents the question, and appends an
 * answer entry with the same id. This strategy polls until the
 * answer appears or the timeout expires.
 *
 * @param config - Optional configuration overrides.
 */
export function createTuiStrategy(config?: TuiStrategyConfig): AnswerStrategy {
  const queuePath = config?.queuePath ?? resolve(process.cwd(), ".grove", "ask-user-queue.jsonl");
  const pollIntervalMs = config?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: "tui",

    async answer(input: AskUserInput): Promise<string> {
      const id = crypto.randomUUID();
      const entry: QuestionEntry = {
        type: "question",
        id,
        question: input.question,
        options: input.options ?? [],
        context: input.context ?? "",
        timestamp: new Date().toISOString(),
      };

      // Ensure the parent directory exists before writing
      const dir = dirname(queuePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Write question to queue
      appendFileSync(queuePath, `${JSON.stringify(entry)}\n`);

      // Poll for answer
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));

        if (!existsSync(queuePath)) continue;
        const lines = readFileSync(queuePath, "utf-8").split("\n").filter(Boolean);

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as AnswerEntry;
            if (parsed.type === "answer" && parsed.id === id && parsed.answer) {
              return parsed.answer;
            }
          } catch {
            /* malformed line — skip */
          }
        }
      }

      // Timeout — return safe default
      return input.options?.[0] ?? "Proceed with the simpler, more conventional approach.";
    },
  };
}
