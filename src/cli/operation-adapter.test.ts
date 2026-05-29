import { describe, expect, test } from "bun:test";
import type { HookRunner } from "../core/hooks.js";
import type { CliDeps } from "./context.js";
import { toOperationDeps } from "./operation-adapter.js";

describe("CLI operation adapter", () => {
  test("forwards hook runner and project cwd when provided", () => {
    const hookRunner: HookRunner = {
      async run(entry, cwd) {
        return {
          success: true,
          exitCode: 0,
          stdout: cwd,
          stderr: "",
          command: typeof entry === "string" ? entry : entry.cmd,
          durationMs: 0,
        };
      },
    };

    const deps = {
      store: {},
      claimStore: {},
      frontier: {},
      workspace: {},
      cas: {},
      groveRoot: "/repo",
      hookRunner,
      hookCwd: "/repo",
      close: () => undefined,
    } as unknown as CliDeps;

    const operationDeps = toOperationDeps(deps);

    expect(operationDeps.hookRunner).toBe(hookRunner);
    expect(operationDeps.hookCwd).toBe("/repo");
  });
});
