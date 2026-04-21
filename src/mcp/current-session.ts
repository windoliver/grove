/**
 * Helpers for reading and validating `.grove/current-session.json`.
 */

/**
 * Error raised when the current-session state file exists but cannot be
 * parsed or does not match the expected shape.
 */
export class SessionStateReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionStateReadError";
  }
}

/**
 * Parse and validate a current-session payload.
 *
 * Expected shape:
 *   { "sessionId": "<non-empty string>" }
 */
export function parseCurrentSessionPayload(rawText: string, sessionFile: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new SessionStateReadError(
      `read/parse ${sessionFile} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SessionStateReadError(
      `read/parse ${sessionFile} failed: expected an object with a non-empty string sessionId`,
    );
  }

  const sessionId = (parsed as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    throw new SessionStateReadError(
      `read/parse ${sessionFile} failed: expected a non-empty string sessionId`,
    );
  }

  return sessionId;
}
