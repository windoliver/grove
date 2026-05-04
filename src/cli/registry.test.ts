/**
 * Regression tests for CLI command registry metadata.
 *
 * `COMMANDS` powers shell completions and must stay aligned with dispatch in
 * `main.ts` and parser options in command handlers.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { CommandMeta } from "./registry.js";
import { COMMANDS } from "./registry.js";

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function getDispatchedCommandNames(): readonly string[] {
  const source = readFileSync(join(import.meta.dir, "main.ts"), "utf-8");
  return [...source.matchAll(/name:\s*"([^"]+)"/g)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
}

function getCommand(name: string): CommandMeta {
  const command = COMMANDS.find((cmd) => cmd.name === name);
  if (!command) {
    throw new Error(`Missing command '${name}' in COMMANDS registry`);
  }
  return command;
}

function getSubcommand(commandName: string, subcommandName: string): CommandMeta {
  const command = getCommand(commandName);
  const subcommand = command.subcommands?.find((sub) => sub.name === subcommandName);
  if (!subcommand) {
    throw new Error(`Missing subcommand '${commandName} ${subcommandName}' in COMMANDS registry`);
  }
  return subcommand;
}

describe("COMMANDS registry", () => {
  test("has unique top-level command names", () => {
    const names = COMMANDS.map((cmd) => cmd.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("stays in sync with main.ts command dispatch names", () => {
    const registryNames = sortedUnique(COMMANDS.map((cmd) => cmd.name));
    const dispatchedNames = sortedUnique(getDispatchedCommandNames());
    expect(registryNames).toEqual(dispatchedNames);
  });

  test("has unique flags for every command and subcommand", () => {
    for (const command of COMMANDS) {
      expect(sortedUnique(command.flags)).toEqual([...command.flags].sort());
      for (const subcommand of command.subcommands ?? []) {
        expect(sortedUnique(subcommand.flags)).toEqual([...subcommand.flags].sort());
      }
    }
  });

  test("keeps updated top-level command flags in sync", () => {
    const expectedFlags: Record<string, readonly string[]> = {
      init: [
        "seed",
        "mode",
        "metric",
        "description",
        "force",
        "preset",
        "nexus-url",
        "nexus-channel",
        "agent-id",
        "agent-name",
        "provider",
        "model",
        "platform",
        "role",
      ],
      up: ["headless", "no-tui", "grove", "build", "nexus-source", "help"],
      down: ["grove", "help"],
      contribute: [
        "kind",
        "mode",
        "summary",
        "description",
        "artifacts",
        "from-git-diff",
        "from-git-tree",
        "from-report",
        "parent",
        "reviews",
        "responds-to",
        "adopts",
        "reproduces",
        "metric",
        "score",
        "tag",
        "idempotency-key",
        "agent-id",
        "agent-name",
        "provider",
        "model",
        "platform",
        "role",
        "json",
      ],
      release: ["completed", "json"],
      checkout: ["to", "frontier", "agent", "json"],
      thread: ["depth", "n", "json"],
      ask: ["options", "context", "strategy", "config"],
      export: ["to-discussion", "to-pr", "category"],
      "export-dag": ["kind", "mode", "agent", "tag", "from", "depth", "n", "output"],
      tui: ["interval", "url", "nexus", "grove", "help"],
      diagnostics: ["exclude-db", "scrub", "slot", "out", "help"],
    };

    for (const [commandName, expected] of Object.entries(expectedFlags)) {
      const command = getCommand(commandName);
      expect(sortedUnique(command.flags)).toEqual(sortedUnique(expected));
    }
  });

  test("keeps updated subcommand flags in sync", () => {
    const expectedSubcommands: ReadonlyArray<{
      readonly command: string;
      readonly subcommand: string;
      readonly flags: readonly string[];
    }> = [
      { command: "outcome", subcommand: "set", flags: ["reason", "baseline", "evaluator", "json"] },
      { command: "outcome", subcommand: "list", flags: ["status", "n", "json"] },
      { command: "goal", subcommand: "get", flags: [] },
      { command: "goal", subcommand: "set", flags: ["acceptance"] },
      {
        command: "session",
        subcommand: "start",
        flags: ["goal", "preset", "roles", "runtime"],
      },
      { command: "session", subcommand: "list", flags: [] },
      { command: "session", subcommand: "status", flags: [] },
      { command: "session", subcommand: "stop", flags: ["reason"] },
      { command: "skill", subcommand: "install", flags: ["server-url", "mcp-url"] },
      { command: "gossip", subcommand: "peers", flags: ["server", "json"] },
      { command: "gossip", subcommand: "status", flags: ["server", "json"] },
      { command: "gossip", subcommand: "frontier", flags: ["server", "json"] },
      { command: "gossip", subcommand: "watch", flags: ["server", "interval", "json"] },
      { command: "gossip", subcommand: "exchange", flags: ["peer-id", "json"] },
      { command: "gossip", subcommand: "shuffle", flags: ["peer-id", "json"] },
      { command: "gossip", subcommand: "sync", flags: ["peer-id", "json"] },
      { command: "gossip", subcommand: "daemon", flags: ["peer-id", "port", "interval"] },
    ];

    for (const expected of expectedSubcommands) {
      const subcommand = getSubcommand(expected.command, expected.subcommand);
      expect(sortedUnique(subcommand.flags)).toEqual(sortedUnique(expected.flags));
    }
  });

  test("does not reintroduce stale completion flags", () => {
    expect(getCommand("contribute").flags).not.toContain("seed");
    expect(getCommand("ask").flags).not.toContain("rules-file");
  });
});
