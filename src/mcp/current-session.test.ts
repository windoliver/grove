import { describe, expect, test } from "bun:test";

import { parseCurrentSessionPayload, SessionStateReadError } from "./current-session.js";

const TEST_FILE = "/tmp/current-session.json";

function expectSessionReadError(run: () => void): SessionStateReadError {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(SessionStateReadError);
    return err as SessionStateReadError;
  }
  throw new Error("Expected SessionStateReadError");
}

describe("parseCurrentSessionPayload", () => {
  test("parses valid payload", () => {
    const sessionId = parseCurrentSessionPayload('{"sessionId":"sess-123"}', TEST_FILE);
    expect(sessionId).toBe("sess-123");
  });

  test("throws for invalid JSON", () => {
    const err = expectSessionReadError(() =>
      parseCurrentSessionPayload('{"sessionId":', TEST_FILE),
    );
    expect(err.message).toContain("read/parse");
  });

  test("throws for non-object payload", () => {
    const err = expectSessionReadError(() => parseCurrentSessionPayload('"sess-123"', TEST_FILE));
    expect(err.message).toContain("expected an object");
  });

  test("throws for missing sessionId", () => {
    const err = expectSessionReadError(() => parseCurrentSessionPayload("{}", TEST_FILE));
    expect(err.message).toContain("non-empty string sessionId");
  });

  test("throws for non-string sessionId", () => {
    const err = expectSessionReadError(() =>
      parseCurrentSessionPayload('{"sessionId":123}', TEST_FILE),
    );
    expect(err.message).toContain("non-empty string sessionId");
  });

  test("throws for blank sessionId", () => {
    const err = expectSessionReadError(() =>
      parseCurrentSessionPayload('{"sessionId":"   "}', TEST_FILE),
    );
    expect(err.message).toContain("non-empty string sessionId");
  });
});
