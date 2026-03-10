/**
 * GitHub reference parsers with Zod validation.
 *
 * Parses and validates user input for repository, PR, and Discussion
 * references used in CLI commands.
 */

import { z } from "zod/v4";

import type { DiscussionRef, PRRef, RepoRef } from "./types.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** GitHub owner: 1-39 chars, alphanumeric + hyphen, no leading/trailing hyphen. */
const OwnerSchema = z
  .string()
  .regex(
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/,
    "Invalid GitHub owner: must be 1-39 alphanumeric characters or hyphens",
  );

/** GitHub repo name: 1-100 chars, alphanumeric + hyphen + dot + underscore. */
const RepoNameSchema = z
  .string()
  .regex(
    /^[a-zA-Z0-9._-]{1,100}$/,
    "Invalid GitHub repo name: must be 1-100 alphanumeric characters, hyphens, dots, or underscores",
  );

/** Positive integer for PR/Discussion numbers. */
const IssueNumberSchema = z.number().int().positive();

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Parse a repository reference in "owner/repo" format.
 *
 * @param input - String like "windoliver/grove".
 * @returns Parsed RepoRef.
 * @throws If the input does not match "owner/repo" format.
 */
export function parseRepoRef(input: string): RepoRef {
  const trimmed = input.trim();
  const slashIndex = trimmed.indexOf("/");

  if (slashIndex === -1) {
    throw new Error(`Invalid repo reference '${trimmed}': expected 'owner/repo' format`);
  }

  // Only split on the first slash (repo names can't contain slashes, but be defensive)
  const owner = trimmed.slice(0, slashIndex);
  const repo = trimmed.slice(slashIndex + 1);

  if (repo.includes("/")) {
    throw new Error(`Invalid repo reference '${trimmed}': unexpected extra '/' in repo name`);
  }

  const ownerResult = OwnerSchema.safeParse(owner);
  if (!ownerResult.success) {
    throw new Error(`Invalid repo reference '${trimmed}': ${ownerResult.error.issues[0]?.message}`);
  }

  const repoResult = RepoNameSchema.safeParse(repo);
  if (!repoResult.success) {
    throw new Error(`Invalid repo reference '${trimmed}': ${repoResult.error.issues[0]?.message}`);
  }

  return { owner, repo };
}

/**
 * Parse a PR reference in "owner/repo#number" format.
 *
 * @param input - String like "windoliver/myproject#44".
 * @returns Parsed PRRef.
 * @throws If the input does not match "owner/repo#number" format.
 */
export function parsePRRef(input: string): PRRef {
  const trimmed = input.trim();
  const hashIndex = trimmed.lastIndexOf("#");

  if (hashIndex === -1) {
    throw new Error(`Invalid PR reference '${trimmed}': expected 'owner/repo#number' format`);
  }

  const repoPartStr = trimmed.slice(0, hashIndex);
  const numberStr = trimmed.slice(hashIndex + 1);

  const parsed = Number.parseInt(numberStr, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid PR reference '${trimmed}': '${numberStr}' is not a valid number`);
  }

  const numberResult = IssueNumberSchema.safeParse(parsed);
  if (!numberResult.success) {
    throw new Error(`Invalid PR reference '${trimmed}': number must be a positive integer`);
  }

  const repoRef = parseRepoRef(repoPartStr);
  return { ...repoRef, number: parsed };
}

/**
 * Parse a Discussion reference in "owner/repo#number" format.
 *
 * Same format as PR references but typed differently for clarity.
 *
 * @param input - String like "windoliver/myproject#43".
 * @returns Parsed DiscussionRef.
 * @throws If the input does not match "owner/repo#number" format.
 */
export function parseDiscussionRef(input: string): DiscussionRef {
  const trimmed = input.trim();
  const hashIndex = trimmed.lastIndexOf("#");

  if (hashIndex === -1) {
    throw new Error(
      `Invalid Discussion reference '${trimmed}': expected 'owner/repo#number' format`,
    );
  }

  const repoPartStr = trimmed.slice(0, hashIndex);
  const numberStr = trimmed.slice(hashIndex + 1);

  const parsed = Number.parseInt(numberStr, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Invalid Discussion reference '${trimmed}': '${numberStr}' is not a valid number`,
    );
  }

  const numberResult = IssueNumberSchema.safeParse(parsed);
  if (!numberResult.success) {
    throw new Error(`Invalid Discussion reference '${trimmed}': number must be a positive integer`);
  }

  const repoRef = parseRepoRef(repoPartStr);
  return { ...repoRef, number: parsed };
}
