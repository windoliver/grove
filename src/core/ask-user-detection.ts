/**
 * Utilities for detecting and formatting ask_user contributions.
 *
 * The TUI and CLI can use these to surface ask_user prominently.
 */

import type { Contribution } from "./models.js";

/** Check if a contribution is an ask_user request. */
export function isAskUser(contribution: Contribution): boolean {
  return contribution.kind === "ask_user";
}

/** Check if a contribution is a response to an ask_user. */
export function isResponse(contribution: Contribution): boolean {
  return contribution.kind === "response";
}

/** Extract the question from an ask_user contribution. */
export function extractQuestion(contribution: Contribution): string | undefined {
  if (contribution.kind !== "ask_user") return undefined;
  const question = contribution.context?.question;
  return typeof question === "string" ? question : contribution.summary;
}

/** Extract choices from an ask_user contribution. */
export function extractChoices(contribution: Contribution): readonly string[] | undefined {
  if (contribution.kind !== "ask_user") return undefined;
  const choices = contribution.context?.choices;
  if (Array.isArray(choices) && choices.every((c) => typeof c === "string")) {
    return choices as string[];
  }
  return undefined;
}

/** Format an ask_user contribution for display. */
export function formatAskUser(contribution: Contribution): string {
  const question = extractQuestion(contribution);
  const choices = extractChoices(contribution);
  const agent =
    contribution.agent.agentName ?? contribution.agent.role ?? contribution.agent.agentId;

  let formatted = `\u2753 ${agent} asks: ${question ?? contribution.summary}`;
  if (choices !== undefined && choices.length > 0) {
    formatted += `\n   Options: ${choices.join(" | ")}`;
  }
  return formatted;
}

/**
 * Filter contributions to find pending ask_user requests
 * (ask_user with no response linked via responds_to).
 */
export function findPendingQuestions(
  contributions: readonly Contribution[],
): readonly Contribution[] {
  // Find all ask_user contributions
  const askUsers = contributions.filter(isAskUser);

  // Find all response contributions that have responds_to relations
  const answeredCids = new Set<string>();
  for (const c of contributions) {
    if (c.kind === "response") {
      for (const rel of c.relations) {
        if (rel.relationType === "responds_to") {
          answeredCids.add(rel.targetCid);
        }
      }
    }
  }

  // Return ask_user contributions that haven't been answered
  return askUsers.filter((c) => !answeredCids.has(c.cid));
}
