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

  test("standard mode scrubs quoted secret assignment values", () => {
    const input = [
      'TOKEN="secret"',
      'password: "secret"',
      '{"token":"secret","password":"secret","ok":1}',
    ].join("\n");

    const redacted = redactText(input, {
      mode: "standard",
      homeDir: "/Users/tafeng",
      secretEnvKeys: ["TOKEN"],
    });

    expect(redacted).toContain('TOKEN="<redacted>"');
    expect(redacted).toContain('password: "<redacted>"');
    expect(redacted).toContain('"token":"<redacted>"');
    expect(redacted).toContain('"password":"<redacted>"');
    expect(redacted).toContain('"ok":1');
  });

  test("standard mode scrubs quoted secret values with escaped quotes", () => {
    const input = ['TOKEN="abc\\"def"', '{"token":"abc\\"def","ok":1}'].join("\n");

    const redacted = redactText(input, {
      mode: "standard",
      homeDir: "/Users/tafeng",
      secretEnvKeys: ["TOKEN"],
    });

    expect(redacted).toBe(['TOKEN="<redacted>"', '{"token":"<redacted>","ok":1}'].join("\n"));
    expect(redacted).not.toContain("def");
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

  test("aggressive mode scrubs bearer tokens outside authorization headers", () => {
    const input = "cmd=Bearer abcdef1234567890abcdef1234567890";

    const redacted = redactText(input, {
      mode: "aggressive",
      homeDir: "/Users/tafeng",
      secretEnvKeys: [],
    });

    expect(redacted).toBe("cmd=Bearer <redacted>");
  });

  test("aggressive mode scrubs non-home absolute paths after assignments", () => {
    const input = "config=/etc/grove/config.json";

    const redacted = redactText(input, {
      mode: "aggressive",
      homeDir: "/Users/tafeng",
      secretEnvKeys: [],
    });

    expect(redacted).toBe("config=<redacted-path>");
  });

  test("aggressive mode preserves route-like slash assignment values", () => {
    const input = "redirect=/api/health&ok=1";

    const redacted = redactText(input, {
      mode: "aggressive",
      homeDir: "/Users/tafeng",
      secretEnvKeys: [],
    });

    expect(redacted).toBe("redirect=/api/health&ok=1");
  });

  test("aggressive mode scrubs filesystem paths with query suffixes", () => {
    const input = "path=/tmp/grove?debug=1";

    const redacted = redactText(input, {
      mode: "aggressive",
      homeDir: "/Users/tafeng",
      secretEnvKeys: [],
    });

    expect(redacted).toBe("path=<redacted-path>");
  });

  test("off mode preserves text", () => {
    const input = "EMAIL=user@example.com\nTOKEN=secret";
    expect(redactText(input, { mode: "off", homeDir: "/Users/tafeng", secretEnvKeys: [] })).toBe(
      input,
    );
  });
});
