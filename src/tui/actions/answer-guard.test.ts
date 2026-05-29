import { describe, expect, test } from "bun:test";
import { resolveAnswerableQuestion } from "./answer-guard.js";

describe("resolveAnswerableQuestion", () => {
  test("exactly one pending, no expected cid → that question", () => {
    const q = { cid: "bafyQ1", options: ["Yes"] };
    expect(resolveAnswerableQuestion([q], undefined)).toBe(q);
  });

  test("exactly one pending matching expected cid → that question", () => {
    const q = { cid: "bafyQ1" };
    expect(resolveAnswerableQuestion([q], "bafyQ1")).toBe(q);
  });

  test("zero pending → undefined", () => {
    expect(resolveAnswerableQuestion([], "bafyQ1")).toBeUndefined();
  });

  test("multiple pending → undefined (ambiguous, do not blind-answer)", () => {
    expect(
      resolveAnswerableQuestion([{ cid: "bafyQ1" }, { cid: "bafyQ2" }], "bafyQ1"),
    ).toBeUndefined();
  });

  test("single pending but identity changed → undefined", () => {
    // The action was shown for bafyQ1, but the only remaining question is now a
    // different one (the original was answered/removed and a new one arrived).
    expect(resolveAnswerableQuestion([{ cid: "bafyQ2" }], "bafyQ1")).toBeUndefined();
  });
});
