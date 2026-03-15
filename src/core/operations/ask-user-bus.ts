/**
 * Ask-user event bus operations.
 *
 * Stores pending questions from agents and operator answers
 * as ephemeral discussion contributions. The TUI polls for
 * pending questions and writes answers back.
 *
 * Architecture: event-bus pattern with Nexus-first storage,
 * SQLite fallback (Issue #90, Decision 2A).
 *
 * Question lifecycle:
 * 1. Agent calls ask_user → contribution with context.ask_user_question
 * 2. TUI polls for pending questions (unanswered)
 * 3. Operator answers → contribution with context.ask_user_answer + responds_to
 * 4. Agent reads answer via responds_to relation
 */

import type { AgentIdentity, Contribution, ContributionInput } from "../models.js";
import { ContributionKind, ContributionMode, RelationType } from "../models.js";
import type { ContributionStore } from "../store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A pending question from an agent. */
export interface PendingQuestion {
  /** CID of the question contribution. */
  readonly cid: string;
  /** The agent that asked. */
  readonly agent: AgentIdentity;
  /** The question text. */
  readonly question: string;
  /** Available options (if any). */
  readonly options?: readonly string[] | undefined;
  /** Additional context for the operator. */
  readonly questionContext?: string | undefined;
  /** When the question was asked. */
  readonly createdAt: string;
  /** Whether this question has been answered. */
  readonly answered: boolean;
  /** TTL in seconds — question expires after this. */
  readonly ttlSeconds?: number | undefined;
}

/** Input for submitting a question. */
export interface SubmitQuestionInput {
  readonly agent: AgentIdentity;
  readonly question: string;
  readonly options?: readonly string[] | undefined;
  readonly questionContext?: string | undefined;
  readonly ttlSeconds?: number | undefined;
}

/** Input for answering a question. */
export interface AnswerQuestionInput {
  /** CID of the question contribution. */
  readonly questionCid: string;
  /** The answer text. */
  readonly answer: string;
  /** The operator agent identity. */
  readonly operator: AgentIdentity;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Default TTL for questions (5 minutes). */
const DEFAULT_TTL_SECONDS = 300;

/**
 * Submit a question from an agent.
 *
 * Stored as an ephemeral discussion contribution with structured
 * question metadata in the context field.
 */
export async function submitQuestion(
  store: ContributionStore,
  input: SubmitQuestionInput,
  computeCid: (input: ContributionInput) => string,
): Promise<Contribution> {
  if (input.question.trim().length === 0) {
    throw new Error("Question cannot be empty");
  }

  const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

  const contributionInput: ContributionInput = {
    kind: ContributionKind.Discussion,
    mode: ContributionMode.Exploration,
    summary: `Question: ${input.question.slice(0, 100)}`,
    description: input.question,
    artifacts: {},
    relations: [],
    tags: ["ask-user", "question"],
    context: {
      ephemeral: true,
      ask_user_question: true,
      question_text: input.question,
      ...(input.options !== undefined && { question_options: [...input.options] }),
      ...(input.questionContext !== undefined && { question_context: input.questionContext }),
      ttl_seconds: ttl,
      expires_at: expiresAt,
    },
    agent: input.agent,
    createdAt: new Date().toISOString(),
  };

  const cid = computeCid(contributionInput);
  const contribution: Contribution = {
    ...contributionInput,
    cid,
    manifestVersion: 1,
  };

  await store.put(contribution);
  return contribution;
}

/**
 * Answer a pending question.
 *
 * Creates an ephemeral discussion contribution that responds_to
 * the question contribution.
 */
export async function answerQuestion(
  store: ContributionStore,
  input: AnswerQuestionInput,
  computeCid: (input: ContributionInput) => string,
): Promise<Contribution> {
  // Verify the question exists
  const question = await store.get(input.questionCid);
  if (question === undefined) {
    throw new Error(`Question not found: ${input.questionCid}`);
  }
  if (question.context?.ask_user_question !== true) {
    throw new Error(`Contribution ${input.questionCid} is not a question`);
  }

  const contributionInput: ContributionInput = {
    kind: ContributionKind.Discussion,
    mode: ContributionMode.Exploration,
    summary: `Answer: ${input.answer.slice(0, 100)}`,
    description: input.answer,
    artifacts: {},
    relations: [{ targetCid: input.questionCid, relationType: RelationType.RespondsTo }],
    tags: ["ask-user", "answer"],
    context: {
      ephemeral: true,
      ask_user_answer: true,
      answer_text: input.answer,
    },
    agent: input.operator,
    createdAt: new Date().toISOString(),
  };

  const cid = computeCid(contributionInput);
  const contribution: Contribution = {
    ...contributionInput,
    cid,
    manifestVersion: 1,
  };

  await store.put(contribution);
  return contribution;
}

/**
 * List pending (unanswered) questions.
 *
 * A question is pending if:
 * - It has context.ask_user_question = true
 * - No responds_to relation points to it with ask_user_answer = true
 * - It has not expired (expires_at > now)
 */
export async function listPendingQuestions(
  store: ContributionStore,
): Promise<readonly PendingQuestion[]> {
  const contributions = await store.list({
    kind: ContributionKind.Discussion,
  });

  const questions = contributions.filter(
    (c) => c.context?.ephemeral === true && c.context?.ask_user_question === true,
  );

  // Find answered question CIDs
  const answeredCids = new Set<string>();
  const answers = contributions.filter(
    (c) => c.context?.ephemeral === true && c.context?.ask_user_answer === true,
  );
  for (const a of answers) {
    for (const rel of a.relations) {
      if (rel.relationType === RelationType.RespondsTo) {
        answeredCids.add(rel.targetCid);
      }
    }
  }

  const now = Date.now();

  return questions
    .map((c): PendingQuestion => {
      const expiresAt = c.context?.expires_at as string | undefined;
      const expired = expiresAt !== undefined && Date.parse(expiresAt) < now;
      const answered = answeredCids.has(c.cid);

      return {
        cid: c.cid,
        agent: c.agent,
        question: (c.context?.question_text as string) ?? c.description ?? c.summary,
        options: c.context?.question_options as string[] | undefined,
        questionContext: c.context?.question_context as string | undefined,
        createdAt: c.createdAt,
        answered: answered || expired,
        ttlSeconds: c.context?.ttl_seconds as number | undefined,
      };
    })
    .filter((q) => !q.answered)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/**
 * Get the answer for a question (if answered).
 */
export async function getAnswer(
  store: ContributionStore,
  questionCid: string,
): Promise<string | undefined> {
  const children = await store.relatedTo(questionCid, RelationType.RespondsTo);
  const answer = children.find(
    (c) => c.context?.ephemeral === true && c.context?.ask_user_answer === true,
  );
  return answer !== undefined
    ? ((answer.context?.answer_text as string) ?? answer.description ?? answer.summary)
    : undefined;
}
