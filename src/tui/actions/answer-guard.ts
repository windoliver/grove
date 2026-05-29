/**
 * Pure guard for the palette's approve/deny actions. Re-validates, at execution
 * time, that the pending-question set is still safe to answer blindly:
 * exactly one question must remain AND (when an expected cid is supplied) it
 * must be the same question that made the action available. Anything else
 * (a question added/removed/replaced between palette render and Enter) returns
 * `undefined` so the caller aborts instead of answering the wrong prompt.
 *
 * Kept pure/separate from app.tsx so the TOCTOU contract is unit-testable.
 */

export interface PendingQuestion {
  readonly cid: string;
  readonly options?: readonly string[] | undefined;
}

export function resolveAnswerableQuestion(
  questions: readonly PendingQuestion[],
  expectedCid: string | undefined,
): PendingQuestion | undefined {
  // Ambiguous: not exactly one pending question anymore.
  if (questions.length !== 1) return undefined;
  const q = questions[0];
  if (q === undefined) return undefined;
  // Identity changed: the single remaining question is not the one the operator
  // saw when they invoked the action.
  if (expectedCid !== undefined && q.cid !== expectedCid) return undefined;
  return q;
}
