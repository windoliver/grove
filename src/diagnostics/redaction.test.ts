import { describe, expect, test } from "bun:test";
import { isTextEntryPath, redactText } from "./redaction.js";

describe("isTextEntryPath", () => {
  test("classifies diagnostics text files", () => {
    expect(isTextEntryPath("meta.json")).toBe(true);
    expect(isTextEntryPath("db/contributions-recent.jsonl")).toBe(true);
    expect(isTextEntryPath("logs/grove-runtime.log")).toBe(true);
    expect(isTextEntryPath("system/open-fds.txt")).toBe(true);
    expect(isTextEntryPath("README.md")).toBe(true);
    expect(isTextEntryPath("db/grove.db")).toBe(false);
  });
});

describe("redactText", () => {
  test("standard mode scrubs API keys, home paths, emails, and sensitive query values", () => {
    const input = [
      "OPENAI_API_KEY=sk-test-1234567890abcdef",
      "path=/Users/tafeng/project/.grove",
      "email=user@example.com",
      "url=https://example.test/callback?token=secret&ok=1&key=abc",
    ].join("\n");

    const redacted = redactText(input, {
      mode: "standard",
      homeDir: "/Users/tafeng",
      secretEnvKeys: ["OPENAI_API_KEY"],
    });

    expect(redacted).toContain("OPENAI_API_KEY=<redacted>");
    expect(redacted).toContain("path=~/project/.grove");
    expect(redacted).toContain("email=<redacted>");
    expect(redacted).toContain("token=<redacted>");
    expect(redacted).toContain("key=<redacted>");
    expect(redacted).toContain("ok=1");
  });

  test("aggressive mode scrubs bearer-like tokens, non-home paths, and private key blocks", () => {
    const input = [
      "Authorization: Bearer abcdef1234567890abcdef1234567890",
      "other=/private/tmp/grove-test",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "abcdef",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");

    const redacted = redactText(input, {
      mode: "aggressive",
      homeDir: "/Users/tafeng",
      secretEnvKeys: [],
    });

    expect(redacted).toContain("Authorization: Bearer <redacted>");
    expect(redacted).toContain("other=<redacted-path>");
    expect(redacted).toContain("-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(redacted).toContain("<redacted-private-key>");
    expect(redacted).toContain("-----END OPENSSH PRIVATE KEY-----");
  });

  test("off mode preserves text", () => {
    const input = "EMAIL=user@example.com\nTOKEN=secret";
    expect(redactText(input, { mode: "off", homeDir: "/Users/tafeng", secretEnvKeys: [] })).toBe(
      input,
    );
  });
});
