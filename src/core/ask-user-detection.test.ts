import { describe, expect, test } from "bun:test";
import type { Contribution } from "./models.js";
import {
  extractChoices,
  extractQuestion,
  findPendingQuestions,
  formatAskUser,
  isAskUser,
  isResponse,
} from "./ask-user-detection.js";

function makeContribution(overrides: Partial<Contribution>): Contribution {
  return {
    cid: "blake3:test",
    manifestVersion: 1,
    kind: "work",
    mode: "exploration",
    summary: "Test contribution",
    artifacts: {},
    relations: [],
    tags: [],
    agent: { agentId: "agent-1", agentName: "TestAgent", role: "coder" },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("isAskUser", () => {
  test("returns true for ask_user kind", () => {
    const c = makeContribution({ kind: "ask_user" });
    expect(isAskUser(c)).toBe(true);
  });

  test("returns false for other kinds", () => {
    const c = makeContribution({ kind: "work" });
    expect(isAskUser(c)).toBe(false);
  });
});

describe("isResponse", () => {
  test("returns true for response kind", () => {
    const c = makeContribution({ kind: "response" });
    expect(isResponse(c)).toBe(true);
  });

  test("returns false for other kinds", () => {
    const c = makeContribution({ kind: "work" });
    expect(isResponse(c)).toBe(false);
  });
});

describe("extractQuestion", () => {
  test("returns context.question when present", () => {
    const c = makeContribution({
      kind: "ask_user",
      summary: "fallback summary",
      context: { question: "Which framework?" },
    });
    expect(extractQuestion(c)).toBe("Which framework?");
  });

  test("falls back to summary when no context.question", () => {
    const c = makeContribution({
      kind: "ask_user",
      summary: "Should we use React?",
    });
    expect(extractQuestion(c)).toBe("Should we use React?");
  });

  test("returns undefined for non-ask_user", () => {
    const c = makeContribution({ kind: "work", summary: "Did some work" });
    expect(extractQuestion(c)).toBeUndefined();
  });
});

describe("extractChoices", () => {
  test("returns choices from context", () => {
    const c = makeContribution({
      kind: "ask_user",
      context: { choices: ["React", "Vue", "Svelte"] },
    });
    expect(extractChoices(c)).toEqual(["React", "Vue", "Svelte"]);
  });

  test("returns undefined when no choices in context", () => {
    const c = makeContribution({
      kind: "ask_user",
      context: { question: "Which framework?" },
    });
    expect(extractChoices(c)).toBeUndefined();
  });

  test("returns undefined for non-ask_user", () => {
    const c = makeContribution({ kind: "work" });
    expect(extractChoices(c)).toBeUndefined();
  });

  test("returns undefined when choices are not strings", () => {
    const c = makeContribution({
      kind: "ask_user",
      context: { choices: [1, 2, 3] },
    });
    expect(extractChoices(c)).toBeUndefined();
  });
});

describe("formatAskUser", () => {
  test("formats with agent name and question", () => {
    const c = makeContribution({
      kind: "ask_user",
      summary: "Which DB?",
      agent: { agentId: "a1", agentName: "Coder", role: "coder" },
    });
    const result = formatAskUser(c);
    expect(result).toContain("Coder asks:");
    expect(result).toContain("Which DB?");
  });

  test("includes choices when present", () => {
    const c = makeContribution({
      kind: "ask_user",
      summary: "Which DB?",
      context: { choices: ["Postgres", "SQLite"] },
      agent: { agentId: "a1", agentName: "Coder" },
    });
    const result = formatAskUser(c);
    expect(result).toContain("Options: Postgres | SQLite");
  });

  test("falls back to role when no agentName", () => {
    const c = makeContribution({
      kind: "ask_user",
      summary: "Pick one",
      agent: { agentId: "a1", role: "reviewer" },
    });
    const result = formatAskUser(c);
    expect(result).toContain("reviewer asks:");
  });

  test("falls back to agentId when no name or role", () => {
    const c = makeContribution({
      kind: "ask_user",
      summary: "Pick one",
      agent: { agentId: "agent-42" },
    });
    const result = formatAskUser(c);
    expect(result).toContain("agent-42 asks:");
  });
});

describe("findPendingQuestions", () => {
  test("returns unanswered ask_user contributions", () => {
    const ask1 = makeContribution({
      cid: "blake3:ask1",
      kind: "ask_user",
      summary: "Q1",
    });
    const ask2 = makeContribution({
      cid: "blake3:ask2",
      kind: "ask_user",
      summary: "Q2",
    });
    const response1 = makeContribution({
      cid: "blake3:resp1",
      kind: "response",
      summary: "A1",
      relations: [{ targetCid: "blake3:ask1", relationType: "responds_to" }],
    });

    const pending = findPendingQuestions([ask1, ask2, response1]);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.cid).toBe("blake3:ask2");
  });

  test("returns empty when all are answered", () => {
    const ask = makeContribution({
      cid: "blake3:ask1",
      kind: "ask_user",
      summary: "Q1",
    });
    const response = makeContribution({
      cid: "blake3:resp1",
      kind: "response",
      summary: "A1",
      relations: [{ targetCid: "blake3:ask1", relationType: "responds_to" }],
    });

    const pending = findPendingQuestions([ask, response]);
    expect(pending).toHaveLength(0);
  });

  test("returns all when none are answered", () => {
    const ask1 = makeContribution({
      cid: "blake3:ask1",
      kind: "ask_user",
      summary: "Q1",
    });
    const ask2 = makeContribution({
      cid: "blake3:ask2",
      kind: "ask_user",
      summary: "Q2",
    });

    const pending = findPendingQuestions([ask1, ask2]);
    expect(pending).toHaveLength(2);
  });

  test("ignores non-ask_user contributions", () => {
    const work = makeContribution({ kind: "work", summary: "Did work" });
    const pending = findPendingQuestions([work]);
    expect(pending).toHaveLength(0);
  });
});
