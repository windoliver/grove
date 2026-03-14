/**
 * Tests for shell completion generation.
 */

import { describe, expect, test } from "bun:test";
import { COMMANDS } from "../registry.js";
import { generateCompletions, parseCompletionsArgs } from "./completions.js";

describe("parseCompletionsArgs", () => {
  test("parses bash", () => {
    expect(parseCompletionsArgs(["bash"])).toBe("bash");
  });

  test("parses zsh", () => {
    expect(parseCompletionsArgs(["zsh"])).toBe("zsh");
  });

  test("parses fish", () => {
    expect(parseCompletionsArgs(["fish"])).toBe("fish");
  });

  test("throws for unknown shell", () => {
    expect(() => parseCompletionsArgs(["powershell"])).toThrow(/Unknown shell/);
  });

  test("throws when no shell given", () => {
    expect(() => parseCompletionsArgs([])).toThrow(/Shell argument required/);
  });
});

describe("generateCompletions", () => {
  test("bash: contains all command names", () => {
    const script = generateCompletions("bash");
    for (const cmd of COMMANDS) {
      expect(script).toContain(cmd.name);
    }
  });

  test("bash: contains complete function registration", () => {
    const script = generateCompletions("bash");
    expect(script).toContain("complete -F _grove_completions grove");
  });

  test("bash: includes --help and --version in top-level completions", () => {
    const script = generateCompletions("bash");
    expect(script).toContain("--help");
    expect(script).toContain("--version");
  });

  test("zsh: contains compdef header", () => {
    const script = generateCompletions("zsh");
    expect(script).toContain("#compdef grove");
  });

  test("zsh: dispatches on $line[1] not $words[1]", () => {
    const script = generateCompletions("zsh");
    expect(script).toContain("case $line[1]");
    expect(script).not.toContain("case $words[1]");
  });

  test("zsh: subcommand flags use nested helper functions", () => {
    const script = generateCompletions("zsh");
    // bounty has subcommands, so it should delegate to _grove_bounty
    expect(script).toContain("_grove_bounty()");
    expect(script).toContain("bounty) _grove_bounty ;;");
    // The helper should list subcommands and dispatch their flags
    expect(script).toContain("'create:Create a new bounty'");
    expect(script).toContain("create) _arguments");
    expect(script).toContain("'--amount[amount]'");
  });

  test("zsh: contains all command names with descriptions", () => {
    const script = generateCompletions("zsh");
    for (const cmd of COMMANDS) {
      expect(script).toContain(cmd.name);
      expect(script).toContain(cmd.description);
    }
  });

  test("fish: disables file completions", () => {
    const script = generateCompletions("fish");
    expect(script).toContain("complete -c grove -f");
  });

  test("fish: contains all command names", () => {
    const script = generateCompletions("fish");
    for (const cmd of COMMANDS) {
      expect(script).toContain(cmd.name);
    }
  });

  test("fish: includes flags for commands", () => {
    const script = generateCompletions("fish");
    // frontier has --metric flag
    expect(script).toContain("__fish_seen_subcommand_from frontier");
    expect(script).toContain("-l 'metric'");
  });

  test("bash: includes subcommand flags", () => {
    const script = generateCompletions("bash");
    // bounty create has --amount flag
    expect(script).toContain("--amount");
  });

  test("fish: scopes subcommand flags by both parent and sub", () => {
    const script = generateCompletions("fish");
    // bounty create --amount should be scoped to both 'bounty' AND 'create'
    expect(script).toContain(
      "__fish_seen_subcommand_from bounty; and __fish_seen_subcommand_from create",
    );
    expect(script).toContain("-l 'amount'");
  });

  test("generates completions from custom command list", () => {
    const customCmds = [
      { name: "test-cmd", description: "A test command", flags: ["verbose", "quiet"] },
    ];
    const script = generateCompletions("bash", customCmds);
    expect(script).toContain("test-cmd");
    expect(script).toContain("--verbose");
    expect(script).toContain("--quiet");
  });
});
