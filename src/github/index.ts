/**
 * Public API for the GitHub adapter.
 *
 * Exports the adapter factory, client interface, mapper functions,
 * error types, ref parsers, and test utilities.
 */

// Adapter
export {
  createGitHubAdapter,
  type ExportToDiscussionResult,
  type ExportToPRResult,
  type GitHubAdapterOptions,
  type ImportResult,
} from "./adapter.js";

// Client interface
export type {
  CreateDiscussionParams,
  CreatePRParams,
  GitHubClient,
  PushBranchParams,
} from "./client.js";
// Errors
export {
  classifyGhError,
  GhCliNotFoundError,
  GitHubAdapterError,
  GitHubAuthError,
  GitHubNotFoundError,
  GitHubRateLimitError,
  GitHubValidationError,
} from "./errors.js";
// Client implementation
export { createGhCliClient } from "./gh-cli-client.js";

// Mapper (pure functions)
export {
  contributionToDiscussionBody,
  contributionToPRBody,
  type DiscussionBody,
  discussionToContributionInput,
  type PRBody,
  prToContributionInput,
} from "./mapper.js";

// Outcome poster (Feature 4: Outcome -> GitHub)
export { postCheckRun, postOutcomeComment } from "./outcome-poster.js";

// Ref parsers
export { parseDiscussionRef, parsePRRef, parseRepoRef } from "./refs.js";
// Testing utilities
export {
  InMemoryGitHubClient,
  makeTestComment,
  makeTestDiscussion,
  makeTestDiscussionComment,
  makeTestPR,
  makeTestPRFile,
  makeTestReviewComment,
} from "./testing.js";
// Types
export type {
  CreateDiscussionResult,
  CreatePRResult,
  DiscussionCategory,
  DiscussionComment,
  DiscussionRef,
  GitHubComment,
  GitHubDiscussion,
  GitHubPR,
  PRFile,
  PRRef,
  PRReviewComment,
  RepoRef,
} from "./types.js";
