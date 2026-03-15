import { describe, expect, test } from "bun:test";

import type { Contribution, ContributionInput } from "../models.js";
import { ContributionKind, ContributionMode, RelationType } from "../models.js";
import { InMemoryContributionStore } from "../testing.js";
import { answerQuestion, listPendingQuestions, submitQuestion } from "./ask-user-bus.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Counter-based CID mock that produces unique CIDs per call. */
let cidCounter = 0;
function mockComputeCid(input: ContributionInput): string {
  cidCounter += 1;
  const raw = JSON.stringify(input) + cidCounter.toString();
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 31 + raw.charCodeAt(i)) | 0;
  }
  const hex = Math.abs(hash).toString(16).padStart(8, "0");
  return `blake3:${hex.repeat(8)}`;
}

const AGENT_CODER = { agentId: "coder-1", agentName: "Coder" };
const AGENT_REVIEWER = { agentId: "reviewer-1", agentName: "Reviewer" };
const OPERATOR = { agentId: "operator", agentName: "Operator" };

// Reset counter between tests to keep determinism simple
// (bun:test runs tests serially within a file by default)

// ---------------------------------------------------------------------------
// submitQuestion
// ---------------------------------------------------------------------------

describe("submitQuestion", () => {
  test("creates question contribution with metadata", async () => {
    const store = new InMemoryContributionStore();
    const result = await submitQuestion(
      store,
      {
        agent: AGENT_CODER,
        question: "Should I refactor the database layer?",
        options: ["Yes", "No", "Partially"],
        questionContext: "The current layer has 3 anti-patterns.",
      },
      mockComputeCid,
    );

    expect(result.kind).toBe(ContributionKind.Discussion);
    expect(result.context?.ephemeral).toBe(true);
    expect(result.context?.ask_user_question).toBe(true);
    expect(result.context?.question_text).toBe("Should I refactor the database layer?");
    expect(result.context?.question_options).toEqual(["Yes", "No", "Partially"]);
    expect(result.context?.question_context).toBe("The current layer has 3 anti-patterns.");
    expect(result.context?.ttl_seconds).toBeDefined();
    expect(result.context?.expires_at).toBeDefined();
    expect(result.tags).toContain("ask-user");
    expect(result.tags).toContain("question");

    // Verify stored
    const stored = await store.get(result.cid);
    expect(stored).toBeDefined();
  });

  test("rejects empty question", async () => {
    const store = new InMemoryContributionStore();
    await expect(
      submitQuestion(store, { agent: AGENT_CODER, question: "   " }, mockComputeCid),
    ).rejects.toThrow(/empty/);
  });
});

// ---------------------------------------------------------------------------
// answerQuestion
// ---------------------------------------------------------------------------

describe("answerQuestion", () => {
  test("creates answer with responds_to relation", async () => {
    const store = new InMemoryContributionStore();
    const question = await submitQuestion(
      store,
      { agent: AGENT_CODER, question: "Which approach?" },
      mockComputeCid,
    );

    const answer = await answerQuestion(
      store,
      { questionCid: question.cid, answer: "Use approach B", operator: OPERATOR },
      mockComputeCid,
    );

    expect(answer.context?.ask_user_answer).toBe(true);
    expect(answer.context?.answer_text).toBe("Use approach B");
    expect(answer.relations).toHaveLength(1);
    expect(answer.relations[0]?.relationType).toBe(RelationType.RespondsTo);
    expect(answer.relations[0]?.targetCid).toBe(question.cid);
  });

  test("rejects non-existent question CID", async () => {
    const store = new InMemoryContributionStore();
    const fakeCid = "blake3:0000000000000000000000000000000000000000000000000000000000000000";

    await expect(
      answerQuestion(
        store,
        { questionCid: fakeCid, answer: "Some answer", operator: OPERATOR },
        mockComputeCid,
      ),
    ).rejects.toThrow(/not found/);
  });

  test("rejects answering a non-question contribution", async () => {
    const store = new InMemoryContributionStore();
    // Create a regular discussion contribution (not a question)
    const nonQuestion: Contribution = {
      cid: "blake3:1111111111111111111111111111111111111111111111111111111111111111",
      manifestVersion: 1,
      kind: ContributionKind.Discussion,
      mode: ContributionMode.Exploration,
      summary: "Regular discussion",
      artifacts: {},
      relations: [],
      tags: [],
      context: { ephemeral: true },
      agent: AGENT_CODER,
      createdAt: "2026-01-01T00:00:00Z",
    };
    await store.put(nonQuestion);

    await expect(
      answerQuestion(
        store,
        { questionCid: nonQuestion.cid, answer: "Answer", operator: OPERATOR },
        mockComputeCid,
      ),
    ).rejects.toThrow(/not a question/);
  });
});

// ---------------------------------------------------------------------------
// listPendingQuestions
// ---------------------------------------------------------------------------

describe("listPendingQuestions", () => {
  test("returns only unanswered questions", async () => {
    const store = new InMemoryContributionStore();
    const q1 = await submitQuestion(
      store,
      { agent: AGENT_CODER, question: "Question 1?" },
      mockComputeCid,
    );
    const q2 = await submitQuestion(
      store,
      { agent: AGENT_CODER, question: "Question 2?" },
      mockComputeCid,
    );

    // Answer q1
    await answerQuestion(
      store,
      { questionCid: q1.cid, answer: "Answer 1", operator: OPERATOR },
      mockComputeCid,
    );

    const pending = await listPendingQuestions(store);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.cid).toBe(q2.cid);
    expect(pending[0]?.answered).toBe(false);
  });

  test("excludes answered questions", async () => {
    const store = new InMemoryContributionStore();
    const q = await submitQuestion(
      store,
      { agent: AGENT_CODER, question: "Should I proceed?" },
      mockComputeCid,
    );

    await answerQuestion(
      store,
      { questionCid: q.cid, answer: "Yes, proceed", operator: OPERATOR },
      mockComputeCid,
    );

    const pending = await listPendingQuestions(store);
    expect(pending).toHaveLength(0);
  });

  test("excludes expired questions (TTL)", async () => {
    const store = new InMemoryContributionStore();

    // Create a question with a very short TTL that has already expired.
    // We do this by crafting the contribution directly with an expires_at in the past.
    const expiredQuestion: Contribution = {
      cid: "blake3:2222222222222222222222222222222222222222222222222222222222222222",
      manifestVersion: 1,
      kind: ContributionKind.Discussion,
      mode: ContributionMode.Exploration,
      summary: "Question: Expired question?",
      description: "Expired question?",
      artifacts: {},
      relations: [],
      tags: ["ask-user", "question"],
      context: {
        ephemeral: true,
        ask_user_question: true,
        question_text: "Expired question?",
        ttl_seconds: 1,
        expires_at: "2020-01-01T00:00:00Z", // well in the past
      },
      agent: AGENT_CODER,
      createdAt: "2020-01-01T00:00:00Z",
    };
    await store.put(expiredQuestion);

    const pending = await listPendingQuestions(store);
    expect(pending).toHaveLength(0);
  });

  test("crash recovery: questions persist after re-query from store", async () => {
    const store = new InMemoryContributionStore();

    // Submit a question
    const q = await submitQuestion(
      store,
      { agent: AGENT_CODER, question: "Do we need more GPUs?" },
      mockComputeCid,
    );

    // Simulate "restart" by re-querying from the same store
    // (the store persists data; the caller just re-queries)
    const pendingAfterRestart = await listPendingQuestions(store);
    expect(pendingAfterRestart).toHaveLength(1);
    expect(pendingAfterRestart[0]?.cid).toBe(q.cid);
    expect(pendingAfterRestart[0]?.question).toBe("Do we need more GPUs?");
  });

  test("concurrent questions: multiple agents ask simultaneously, all returned", async () => {
    const store = new InMemoryContributionStore();

    // Simulate concurrent questions from different agents
    const [q1, q2, q3] = await Promise.all([
      submitQuestion(store, { agent: AGENT_CODER, question: "Coder question?" }, mockComputeCid),
      submitQuestion(
        store,
        { agent: AGENT_REVIEWER, question: "Reviewer question?" },
        mockComputeCid,
      ),
      submitQuestion(
        store,
        { agent: { agentId: "agent-3" }, question: "Agent 3 question?" },
        mockComputeCid,
      ),
    ]);

    const pending = await listPendingQuestions(store);
    expect(pending).toHaveLength(3);

    const cids = pending.map((q) => q.cid);
    expect(cids).toContain(q1.cid);
    expect(cids).toContain(q2.cid);
    expect(cids).toContain(q3.cid);
  });
});
